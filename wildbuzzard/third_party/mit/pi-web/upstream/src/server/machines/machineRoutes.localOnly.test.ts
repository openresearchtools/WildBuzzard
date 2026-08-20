import Fastify, { type FastifyInstance } from "fastify";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { registerLocalOnlyMachineRoutes } from "./machineRoutes.js";
import { MachineService } from "./machineService.js";

let app: FastifyInstance;

beforeEach(() => {
  app = Fastify({ logger: false });
  registerLocalOnlyMachineRoutes(app, new MachineService(undefined, {
    localRuntime: () => Promise.resolve({
      packageName: "@jmfederico/pi-web",
      generatedAt: "2026-08-08T00:00:00.000Z",
      components: {
        web: { component: "web", label: "Agent", available: true, capabilities: [] },
        sessiond: { component: "sessiond", label: "Agent session daemon", available: true, capabilities: [] },
      },
      capabilities: [],
    }),
  }));
});

afterEach(async () => {
  await app.close();
});

describe("local-only machine routes", () => {
  it("exposes only the bundled local runtime", async () => {
    const response = await app.inject({ method: "GET", url: "/api/machines" });

    expect(response.statusCode).toBe(200);
    expect(response.json<{ machines: { id: string }[] }>().machines.map((machine) => machine.id)).toEqual(["local"]);
  });

  it("rejects remote machine registration and lookup", async () => {
    const add = await app.inject({ method: "POST", url: "/api/machines", payload: { name: "Remote", baseUrl: "https://example.test" } });
    const health = await app.inject({ method: "GET", url: "/api/machines/remote/health" });

    expect(add.statusCode).toBe(403);
    expect(health.statusCode).toBe(404);
  });

  it("reports bundled local runtime health", async () => {
    const response = await app.inject({ method: "GET", url: "/api/machines/local/health" });

    expect(response.statusCode).toBe(200);
    expect(response.json()).toMatchObject({ machineId: "local", ok: true, status: "online" });
  });
});
