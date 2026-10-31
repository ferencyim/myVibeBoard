import { randomBytes } from "node:crypto";
import { createConnection, createServer } from "node:net";

export interface ShutdownChannelAddress {
  port: number;
  token: string;
}

/** A private capability in the PID lock lets local clients stop the supervisor before HTTP is ready. */
export async function createShutdownChannel(onShutdown: () => void): Promise<{
  address: ShutdownChannelAddress;
  close: () => Promise<void>;
}> {
  const token = randomBytes(32).toString("hex");
  const server = createServer((socket) => {
    socket.setTimeout(2_000, () => socket.destroy());
    let input = "";
    socket.on("error", () => {});
    socket.on("data", (chunk) => {
      input += chunk.toString("utf8");
      if (input.length > 128) return socket.destroy();
      if (!input.includes("\n")) return;
      if (input !== `${token}\n`) return socket.destroy();
      socket.end("ok\n", () => onShutdown());
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      server.off("error", reject);
      resolve();
    });
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Invalid shutdown channel address");
  return {
    address: { port: address.port, token },
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export function requestSupervisorShutdown(address: ShutdownChannelAddress): Promise<void> {
  return new Promise((resolve, reject) => {
    const socket = createConnection({ host: "127.0.0.1", port: address.port });
    socket.setTimeout(2_000, () => socket.destroy(new Error("Shutdown channel timed out")));
    socket.once("connect", () => socket.write(`${address.token}\n`));
    let response = "";
    socket.on("data", (data) => {
      response += data.toString("utf8");
    });
    socket.once("error", reject);
    socket.once("end", () => {
      if (response === "ok\n") resolve();
      else reject(new Error("Shutdown channel rejected request"));
    });
  });
}
