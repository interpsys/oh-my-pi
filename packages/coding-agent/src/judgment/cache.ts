/**
 * Local answer cache for native System One judgments (TypeSafe jev, directly
 * or through OpenRouter).
 *
 * Every request decomposes into its parts: the state it evaluated, one oracle
 * row per question answered about that state, and one usage row per billed
 * provider request. Questions are answered independently of their siblings,
 * so a later request that re-asks any question about an identical state under
 * the same model is answered locally for free, and only its unanswered
 * questions reach the provider.
 *
 * ```text
 * states  (id = sha256(canonical state JSON), state)
 * oracle  (id, state → states.id, model, name, type, instruction, criteria, answer)
 *         UNIQUE (state, model, name, type, instruction, criteria)
 * usage   (id, state → states.id, results = JSON [oracle.id…], provider, model, tokens, price)
 * ```
 *
 * The store is bounded: once its used pages exceed {@link judgmentCacheMaxBytes}
 * the oldest states (insertion order) are pruned with their oracle and usage
 * rows, and the freed pages are returned to the filesystem by incremental
 * auto-vacuum. Reuse of a state is overwhelmingly within hours of its first
 * judgment, so a recent window keeps nearly every hit.
 */
import type { Database, Statement } from "bun:sqlite";
import * as fs from "node:fs";
import * as path from "node:path";
import type { Answer, JudgmentRequest, JudgmentResult, Question, Questions } from "@oh-my-pi/pi-ai";
import * as AIError from "@oh-my-pi/pi-ai/error";
import { isEmbeddedImageContent } from "@oh-my-pi/pi-ai/images/shared";
import {
	$env,
	checkpointWal,
	getJudgmentCacheDbPath,
	isBunTestRuntime,
	logger,
	openSqliteDatabaseSync,
	postmortem,
	stableStringifyJson,
	tryAcquireFileLock,
} from "@oh-my-pi/pi-utils";

/** Default cap on the cache's used database pages: 2 GiB. */
export const DEFAULT_JUDGMENT_CACHE_MAX_BYTES = 2 * 1024 ** 3;
/** A prune deletes down to this share of the cap, so the next one is many records away. */
const PRUNE_TARGET_RATIO = 0.9;
/** States deleted per transaction; the event loop runs between batches. */
const PRUNE_BATCH_STATES = 256;
/** Records between size checks after the first one. */
const PRUNE_CHECK_INTERVAL = 256;
/** WAL bytes kept after a checkpoint; a bulk prune or vacuum would otherwise leave a WAL as large as its writes. */
const WAL_SIZE_LIMIT_BYTES = 64 * 1024 ** 2;

/** Cap from `OMP_JUDGMENT_CACHE_MAX_BYTES` (a positive byte count), else {@link DEFAULT_JUDGMENT_CACHE_MAX_BYTES}. */
export function judgmentCacheMaxBytes(): number {
	const value = Number($env.OMP_JUDGMENT_CACHE_MAX_BYTES);
	return Number.isSafeInteger(value) && value > 0 ? value : DEFAULT_JUDGMENT_CACHE_MAX_BYTES;
}

/** Outcome of one {@link JudgmentCache.prune}. */
export interface JudgmentCachePrune {
	/** States deleted, each with its oracle and usage rows. */
	states: number;
	/** Used page bytes before and after. */
	usedBytesBefore: number;
	usedBytesAfter: number;
	/** Whether a legacy `auto_vacuum=NONE` store was rebuilt with incremental auto-vacuum. */
	vacuumed: boolean;
}

// `auto_vacuum` must precede the first table: an existing store keeps its mode until VACUUM.
const SCHEMA = `
PRAGMA auto_vacuum=INCREMENTAL;
PRAGMA journal_mode=WAL;
PRAGMA journal_size_limit=${WAL_SIZE_LIMIT_BYTES};
PRAGMA synchronous=NORMAL;
PRAGMA foreign_keys=ON;
CREATE TABLE IF NOT EXISTS states (
	id TEXT PRIMARY KEY,
	state TEXT NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS oracle (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	state TEXT NOT NULL REFERENCES states(id),
	model TEXT NOT NULL,
	name TEXT NOT NULL,
	type TEXT NOT NULL,
	instruction TEXT NOT NULL,
	criteria TEXT NOT NULL,
	answer TEXT NOT NULL,
	created_at INTEGER NOT NULL,
	UNIQUE (state, model, name, type, instruction, criteria)
);
CREATE TABLE IF NOT EXISTS usage (
	id INTEGER PRIMARY KEY AUTOINCREMENT,
	state TEXT NOT NULL REFERENCES states(id),
	results TEXT NOT NULL,
	provider TEXT NOT NULL,
	model TEXT NOT NULL,
	input_tokens INTEGER NOT NULL,
	output_tokens INTEGER NOT NULL,
	price REAL NOT NULL,
	created_at INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_usage_state ON usage(state);
`;

/** Cached answers for one request, plus the state identity {@link JudgmentCache.record} reuses. */
export interface CachedAnswers {
	/** `sha256` of canonical state JSON or the namespaced multimodal identity. */
	stateId: string;
	/** Canonical state JSON or a digest-only image envelope, stored once per identity. */
	state: string;
	/** Answers already known for the request's questions, keyed by question id. */
	answers: Record<string, Answer>;
}

interface QuestionKey {
	name: string;
	type: string;
	instruction: string;
	criteria: string;
}

function questionKey(name: string, question: Question): QuestionKey {
	return {
		name,
		type: question.type,
		instruction: question.instructions,
		// `null`, not SQL NULL: NULLs never collide under UNIQUE, which would let duplicates in. A box
		// question's `image` stays local (answers are cached as measured on the sent image), so it is no key.
		criteria: stableStringifyJson(question.type === "box" ? null : (question.criteria ?? null)),
	};
}

function cacheStateIdentity(request: JudgmentRequest): string {
	const state = stableStringifyJson(request.state);
	if (!request.images?.length) return state;

	const images = request.images.map(image => {
		if (!isEmbeddedImageContent(image)) {
			throw new AIError.ValidationError("Judgment cache images must be valid embedded image content");
		}
		return {
			// The wire lowercases MIME types, so case variants of one image share an answer.
			mimeType: image.mimeType.toLowerCase(),
			digest: new Bun.CryptoHasher("sha256").update(Buffer.from(image.data, "base64")).digest("hex"),
			detail: image.detail ?? "auto",
		};
	});
	return `multimodal-judgment-cache-v1:${stableStringifyJson({ state, images })}`;
}

function unixSeconds(): number {
	return Math.floor(Date.now() / 1000);
}

let shared: JudgmentCache | null | undefined;

/**
 * Process-wide cache at {@link getJudgmentCacheDbPath}, opened on first use
 * and closed at exit. `undefined` when the database cannot be opened (the
 * failure is logged once and judgments proceed uncached) and under the test
 * runner, where mocked answers must never persist into or be served from the
 * user's cache; tests inject {@link JudgmentCache.open} explicitly.
 */
export function sharedJudgmentCache(): JudgmentCache | undefined {
	if (isBunTestRuntime()) return undefined;
	if (shared === undefined) {
		try {
			const cache = JudgmentCache.open();
			postmortem.register("judgment-cache", () => cache.close(), { exitOnly: true });
			shared = cache;
			void cache.prune();
		} catch (error) {
			logger.warn("judgment cache unavailable; judgments run uncached", { error: String(error) });
			shared = null;
		}
	}
	return shared ?? undefined;
}

/** SQLite store of native judgment answers and the billed requests that produced them. */
export class JudgmentCache {
	readonly #db: Database;
	readonly #dbPath: string;
	readonly #maxBytes: number;
	readonly #answer: Statement<{ answer: string }, [string, string, string, string, string, string]>;
	readonly #insertState: Statement<unknown, [string, string, number]>;
	readonly #upsertOracle: Statement<{ id: number }, [string, string, string, string, string, string, string, number]>;
	readonly #insertUsage: Statement<unknown, [string, string, string, string, number, number, number, number]>;
	#recordsUntilCheck = 0;
	#pruning: Promise<JudgmentCachePrune | undefined> | undefined;
	#closed = false;

	private constructor(db: Database, dbPath: string, maxBytes: number) {
		this.#db = db;
		this.#dbPath = dbPath;
		this.#maxBytes = maxBytes;
		db.run(SCHEMA);
		this.#answer = db.prepare(
			"SELECT answer FROM oracle WHERE state = ? AND model = ? AND name = ? AND type = ? AND instruction = ? AND criteria = ?",
		);
		this.#insertState = db.prepare("INSERT OR IGNORE INTO states (id, state, created_at) VALUES (?, ?, ?)");
		this.#upsertOracle = db.prepare(`
INSERT INTO oracle (state, model, name, type, instruction, criteria, answer, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)
ON CONFLICT (state, model, name, type, instruction, criteria)
DO UPDATE SET answer = excluded.answer, created_at = excluded.created_at
RETURNING id`);
		this.#insertUsage = db.prepare(`
INSERT INTO usage (state, results, provider, model, input_tokens, output_tokens, price, created_at)
VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
	}

	/**
	 * Open (creating if needed) the cache at `dbPath`, quarantining a corrupt store once.
	 * `maxBytes` caps the used database pages (default {@link judgmentCacheMaxBytes}).
	 * @throws when the directory or database cannot be created.
	 */
	static open(dbPath: string = getJudgmentCacheDbPath(), maxBytes: number = judgmentCacheMaxBytes()): JudgmentCache {
		fs.mkdirSync(path.dirname(dbPath), { recursive: true });
		return openSqliteDatabaseSync(dbPath, db => new JudgmentCache(db, dbPath, maxBytes), { recoverCorruption: true });
	}

	/**
	 * Answers already recorded for `request`'s questions under `model`. Best-effort:
	 * a database failure is logged and reported as no cached answers. Invalid image
	 * input is rejected before the best-effort database lookup.
	 */
	lookup(model: string, request: JudgmentRequest): CachedAnswers {
		const state = cacheStateIdentity(request);
		const stateId = new Bun.CryptoHasher("sha256").update(state).digest("hex");
		const answers: Record<string, Answer> = {};
		try {
			for (const name in request.questions) {
				const key = questionKey(name, request.questions[name]);
				const row = this.#answer.get(stateId, model, key.name, key.type, key.instruction, key.criteria);
				if (row) answers[name] = JSON.parse(row.answer);
			}
		} catch (error) {
			logger.warn("judgment cache lookup failed", { error: String(error) });
			return { stateId, state, answers: {} };
		}
		return { stateId, state, answers };
	}

	/**
	 * Record one billed request: its state, one oracle row per question it
	 * answered, and a usage row linking them to the price paid. Best-effort:
	 * failures are logged and never surface to the judgment.
	 */
	record(model: string, cached: CachedAnswers, questions: Questions, result: JudgmentResult): void {
		const now = unixSeconds();
		try {
			this.#db.transaction(() => {
				this.#insertState.run(cached.stateId, cached.state, now);
				const results: number[] = [];
				for (const name in questions) {
					const key = questionKey(name, questions[name]);
					const row = this.#upsertOracle.get(
						cached.stateId,
						model,
						key.name,
						key.type,
						key.instruction,
						key.criteria,
						JSON.stringify(result.answers[name]),
						now,
					);
					if (row) results.push(row.id);
				}
				this.#insertUsage.run(
					cached.stateId,
					JSON.stringify(results),
					result.provider,
					result.model,
					result.usage.input,
					result.usage.output,
					result.usage.cost.total,
					now,
				);
			})();
		} catch (error) {
			logger.warn("judgment cache write failed", { error: String(error) });
		}
		if (--this.#recordsUntilCheck < 0) {
			this.#recordsUntilCheck = PRUNE_CHECK_INTERVAL;
			void this.prune();
		}
	}

	/** Bytes held by used database pages (the file size minus its free pages). */
	usedBytes(): number {
		return (this.#pragma("page_count") - this.#pragma("freelist_count")) * this.#pragma("page_size");
	}

	#pragma(name: string): number {
		return this.#db.query<Record<string, number>, []>(`PRAGMA ${name}`).get()?.[name] ?? 0;
	}

	/**
	 * Bring the store under its cap: when its pages exceed it, delete the oldest
	 * states with their oracle and usage rows until used pages fill at most 90%
	 * of it, then release the freed pages to the filesystem. The newest state is
	 * never deleted. Runs in short transactions that yield to the event loop
	 * between batches; a prune already running in this process is joined, and
	 * another process's prune makes this one a no-op. Best-effort: failures are
	 * logged, and a store whose pages were freed but not released is retried by
	 * the next prune. Resolves `undefined` when there was nothing to do.
	 */
	prune(): Promise<JudgmentCachePrune | undefined> {
		if (this.#pruning) return this.#pruning;
		try {
			if (this.#pragma("page_count") * this.#pragma("page_size") <= this.#maxBytes)
				return Promise.resolve(undefined);
		} catch (error) {
			logger.warn("judgment cache size check failed", { error: String(error) });
			return Promise.resolve(undefined);
		}
		this.#pruning = this.#prune().finally(() => {
			this.#pruning = undefined;
		});
		return this.#pruning;
	}

	async #prune(): Promise<JudgmentCachePrune | undefined> {
		try {
			const usedBytesBefore = this.usedBytes();
			const lock = tryAcquireFileLock(`${this.#dbPath}.prune`);
			if (!lock) return undefined;
			try {
				return await this.#pruneLocked(usedBytesBefore);
			} finally {
				lock.release();
			}
		} catch (error) {
			if (!this.#closed) logger.warn("judgment cache prune failed", { error: String(error) });
			return undefined;
		}
	}

	async #pruneLocked(usedBytesBefore: number): Promise<JudgmentCachePrune> {
		const db = this.#db;
		using oldest = db.prepare<{ id: string }, [number]>(
			"SELECT id FROM states WHERE rowid < (SELECT max(rowid) FROM states) ORDER BY rowid LIMIT ?",
		);
		const target = this.#maxBytes * PRUNE_TARGET_RATIO;
		// States are only ever deleted from the oldest end, so their rowid span is their count.
		using count = db.prepare<{ n: number }, []>("SELECT coalesce(max(rowid) - min(rowid) + 1, 0) AS n FROM states");
		let states = 0;
		let used = usedBytesBefore;
		while (!this.#closed && used > target) {
			// Delete about as many states as the excess holds at the store's average size, so a
			// small cap is not overshot by a whole batch. Records may land between batches.
			const remaining = count.get()?.n ?? 0;
			const want = Math.ceil(((used - target) * remaining) / used);
			const ids = oldest.all(Math.min(PRUNE_BATCH_STATES, Math.max(1, want))).map(row => row.id);
			if (ids.length === 0) break;
			const list = JSON.stringify(ids);
			db.transaction(() => {
				db.run("DELETE FROM usage WHERE state IN (SELECT value FROM json_each(?))", [list]);
				db.run("DELETE FROM oracle WHERE state IN (SELECT value FROM json_each(?))", [list]);
				db.run("DELETE FROM states WHERE id IN (SELECT value FROM json_each(?))", [list]);
			})();
			states += ids.length;
			await Bun.sleep(0);
			used = this.usedBytes();
		}
		let vacuumed = false;
		if (!this.#closed) {
			const mode = db.query<{ auto_vacuum: number }, []>("PRAGMA auto_vacuum").get()?.auto_vacuum;
			if (mode === 0) {
				// A store created before the cap never returns pages to the filesystem; rebuild it once.
				db.run("PRAGMA auto_vacuum=INCREMENTAL");
				db.run("VACUUM");
				vacuumed = true;
			} else {
				db.run("PRAGMA incremental_vacuum");
			}
			checkpointWal(db);
		}
		const result = { states, usedBytesBefore, usedBytesAfter: this.usedBytes(), vacuumed };
		logger.debug("judgment cache pruned", { ...result });
		return result;
	}

	/** Checkpoint and close the database; the cache must not be used afterwards. */
	close(): void {
		this.#closed = true;
		checkpointWal(this.#db);
		this.#db.close();
	}
}
