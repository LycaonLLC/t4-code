# Protocol provider corpora

These files are synthetic contract examples. They do not contain captured user traffic, real
credentials, or private host data.

Each production `OmpProtocolProvider` should have a versioned corpus and run it through
`protocolProviderCorpus`. A corpus records:

- every logical client message kind and its exact encoded wire frame;
- representative inbound wire frames and their exact normalized T4 events; and
- malformed inputs that the provider must reject.

`schemaVersion` versions the corpus file shape, not the OMP wire protocol. Change a golden wire or
event only when the provider contract intentionally changes. Do not refresh expected values merely
to make a failing test pass; inspect the decoder or encoder change first.
