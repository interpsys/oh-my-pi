# Main branch merge queue

Changes to this fork's `main` branch use the GitHub merge queue. The
`Merge queue validation` check runs the pull-request test suite on the
queue's generated commit before it lands.

The upstream publishing workflow is disabled in this fork. Orb releases use
their separate `orb/v*` branches and `v*-orb.N` tags.
