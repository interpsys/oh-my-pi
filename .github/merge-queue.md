# Main branch merge queue

Changes to this fork's `main` branch use the GitHub merge queue. The
`Merge queue validation` check runs the pull-request test suite on the
queue's generated commit before it lands.

The upstream publishing workflow is disabled in this fork. Orb releases are
triggered by `v*-orb.N` tag pushes (`Orb Release` workflow), which build and
attach the fork binaries, npm tarball, and `SHA256SUMS.txt` to the GitHub
Release without publishing to npm.
