export function nativeWebSocketOrigin(value: string): string {
  const url = new URL(value);
  if (url.protocol !== "wss:") throw new Error("native T4 connections require WSS");
  return `https://${url.host}`;
}
