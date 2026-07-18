# ADR-009: Client protocol provider boundary

- Status: accepted.
- Context: T4 pins one canonical `@oh-my-pi/app-wire` artifact through `@t4-code/protocol`, but the client previously constructed `omp-app/1` frames throughout its runtime. That made a future wire-version change touch transport, reconnect, pairing, terminal, and heartbeat code even when those behaviors had not changed.
- Decision: `OmpClient` consumes an `OmpProtocolProvider`. The provider contract receives T4 client messages, while each version-specific implementation owns wire frame construction, encoding, decoding, command descriptions, and capability lookup. The current `omp-app/1` implementation lives separately from the provider contract. Application code may import the T4 protocol facade, but not the raw vendored app-wire package.
- Consequence: another wire implementation can be added beside `omp-app/1` and selected without duplicating transport or reconnect logic. Outbound wire shapes and version labels now have one owner. Provider tests must cover every outbound message kind and injected-provider routing.
- Non-goals: this does not redefine OMP's canonical wire schema, add a second protocol version, or change the upstream OMP repository. Public inbound frame types remain the pinned app-wire types until a later decision defines stable T4 event shapes.
