const socketPath = process.argv[2];
if (!socketPath) throw new Error("socket path is required");

Bun.serve({
	unix: socketPath,
	fetch: () => new Response("ok"),
});

const lifetime = Promise.withResolvers<void>();
await lifetime.promise;

export {};
