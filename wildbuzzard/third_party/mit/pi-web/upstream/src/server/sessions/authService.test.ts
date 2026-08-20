import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CredentialSynchronizationError,
  ModelRuntime,
  type CreateModelRuntimeOptions,
} from "@earendil-works/pi-coding-agent";
import {
  InMemoryCredentialStore,
  type AuthOperationOptions,
  type Credential,
} from "@earendil-works/pi-ai";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { OAuthFlowState } from "../../shared/apiTypes.js";
import { AuthService, createModelRuntimeForAgentDir, type AuthChange, type AuthServiceLogger } from "./authService.js";
import { OAuthLoginFlowService } from "./oauthLoginFlowService.js";

const tempDirs: string[] = [];

beforeEach(() => {
  // Pi 0.82 uses PI_OFFLINE for refreshes after runtime creation. Auth tests
  // exercise local credential behavior and must never fetch provider catalogs.
  vi.stubEnv("PI_OFFLINE", "1");
});

afterEach(async () => {
  vi.unstubAllEnvs();
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("AuthService", () => {
  it("logs out providers and emits the removed provider id after local state synchronizes", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService({ anthropic: { type: "api_key", key: "sk-test" } });

    await expect(auth.logoutProvider("anthropic")).resolves.toEqual({ accepted: true });

    await expect(credentials.read("anthropic")).resolves.toBeUndefined();
    expect(runtime.getProviderAuthStatus("anthropic")).toEqual({ configured: false });
    expect(changes).toEqual([{ removedProviderId: "anthropic" }]);
    auth.dispose();
  });

  it("persists an API key and attempts every listener when failure logging throws", async () => {
    const loggingFailure = new Error("auth logger failed");
    const error = vi.fn(() => { throw loggingFailure; });
    const logger: AuthServiceLogger = { error };
    const { auth, credentials, changes } = await createAuthService({}, logger);
    const failure = new Error("session auth refresh failed");
    const attempts: string[] = [];
    auth.subscribe(() => {
      attempts.push("throwing");
      throw failure;
    });
    auth.subscribe(async () => {
      await Promise.resolve();
      attempts.push("healthy");
    });

    const state = await auth.startApiKeyLogin("anthropic");
    if (state.prompt === undefined) throw new Error("Expected Anthropic key prompt");
    auth.respondToOAuthFlow(state.flowId, state.prompt.requestId, "sk-test");
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });

    await expect(credentials.read("anthropic")).resolves.toEqual({ type: "api_key", key: "sk-test" });
    expect(changes).toEqual([{}]);
    expect(attempts).toEqual(["throwing", "healthy"]);
    expect(error).toHaveBeenCalledWith(
      { err: failure, operation: "login", providerId: "anthropic", authType: "api_key" },
      "auth-change listener failed",
    );
    auth.dispose();
  });

  it("removes a credential when auth-change propagation rejects", async () => {
    const error = vi.fn();
    const logger: AuthServiceLogger = { error };
    const { auth, credentials, changes } = await createAuthService(
      { anthropic: { type: "api_key", key: "sk-test" } },
      logger,
    );
    const failure = new Error("session logout refresh failed");
    auth.subscribe(() => Promise.reject(failure));

    await expect(auth.logoutProvider("anthropic")).resolves.toEqual({ accepted: true });

    await expect(credentials.read("anthropic")).resolves.toBeUndefined();
    expect(changes).toEqual([{ removedProviderId: "anthropic" }]);
    expect(error).toHaveBeenCalledWith(
      { err: failure, operation: "logout", providerId: "anthropic" },
      "auth-change listener failed",
    );
    auth.dispose();
  });

  it.each([
    new Error("Logout failed"),
    new CredentialSynchronizationError("other-provider", "logout", undefined, { cause: new Error("sync failed") }),
    new CredentialSynchronizationError(
      "anthropic",
      "login",
      { type: "api_key", key: "private-api-key" },
      { cause: new Error("sync failed") },
    ),
  ])("propagates a logout failure that does not prove the requested mutation committed", async (failure) => {
    const logging = vi.fn();
    const { auth, runtime, changes } = await createAuthService(
      { anthropic: { type: "api_key", key: "sk-test" } },
      { error: logging },
    );
    vi.spyOn(runtime, "logout").mockRejectedValue(failure);

    await expect(auth.logoutProvider("anthropic")).rejects.toBe(failure);

    expect(changes).toEqual([]);
    expect(logging).not.toHaveBeenCalled();
    auth.dispose();
  });

  it("executes Cloudflare multi-field API-key setup through the interactive flow", async () => {
    const { auth, credentials, changes } = await createAuthService();

    const state = await auth.startApiKeyLogin("cloudflare-ai-gateway");
    expect(state.prompt).toMatchObject({ message: "Enter Cloudflare API key", promptType: "secret" });
    if (state.prompt === undefined) throw new Error("Expected Cloudflare key prompt");
    auth.respondToOAuthFlow(state.flowId, state.prompt.requestId, "cf-secret");

    await vi.waitFor(() => {
      expect(auth.oauthFlow(state.flowId).prompt).toMatchObject({ message: "Enter Cloudflare account ID", promptType: "text" });
    });
    const accountPrompt = auth.oauthFlow(state.flowId).prompt;
    if (accountPrompt === undefined) throw new Error("Expected Cloudflare account prompt");
    auth.respondToOAuthFlow(state.flowId, accountPrompt.requestId, "account-1");

    await vi.waitFor(() => {
      expect(auth.oauthFlow(state.flowId).prompt).toMatchObject({ message: "Enter Cloudflare AI Gateway ID", promptType: "text" });
    });
    const gatewayPrompt = auth.oauthFlow(state.flowId).prompt;
    if (gatewayPrompt === undefined) throw new Error("Expected Cloudflare gateway prompt");
    auth.respondToOAuthFlow(state.flowId, gatewayPrompt.requestId, "gateway-1");

    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });
    await expect(credentials.read("cloudflare-ai-gateway")).resolves.toEqual({
      type: "api_key",
      key: "cf-secret",
      env: { CLOUDFLARE_ACCOUNT_ID: "account-1", CLOUDFLARE_GATEWAY_ID: "gateway-1" },
    });
    expect(changes).toEqual([{}]);
    auth.dispose();
  });

  it.each([
    { providerId: "amazon-bedrock", selection: "bearer-token", secretPrompt: "Enter Amazon Bedrock bearer token" },
    { providerId: "google-vertex", selection: "api-key", secretPrompt: "Enter Google Cloud API key" },
  ])("executes $providerId select-first API-key setup through the interactive flow", async ({ providerId, selection, secretPrompt }) => {
    const { auth, credentials, changes } = await createAuthService();

    const state = await auth.startApiKeyLogin(providerId);
    expect(state.select).toBeDefined();
    if (state.select === undefined) throw new Error("Expected auth method selection");
    auth.respondToOAuthFlow(state.flowId, state.select.requestId, selection);

    await vi.waitFor(() => {
      expect(auth.oauthFlow(state.flowId).prompt).toMatchObject({ message: secretPrompt, promptType: "secret" });
    });
    const prompt = auth.oauthFlow(state.flowId).prompt;
    if (prompt === undefined) throw new Error("Expected provider secret prompt");
    auth.respondToOAuthFlow(state.flowId, prompt.requestId, "provider-secret");

    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });
    await expect(credentials.read(providerId)).resolves.toEqual({ type: "api_key", key: "provider-secret" });
    expect(changes).toEqual([{}]);
    auth.dispose();
  });

  it("reports a key-only legacy Cloudflare credential as unconfigured", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "");
    const { auth } = await createFileBackedAuthService({
      "cloudflare-ai-gateway": { type: "api_key", key: "legacy-secret" },
    });

    const response = await auth.authProviders("login", "api_key");

    expect(response.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "cloudflare-ai-gateway",
        loginFlow: "interactive",
        status: { configured: false },
      }),
    ]));
    auth.dispose();
  });

  it("reports a stored Cloudflare key as configured when ambient fields complete it", async () => {
    vi.stubEnv("CLOUDFLARE_ACCOUNT_ID", "ambient-account");
    vi.stubEnv("CLOUDFLARE_GATEWAY_ID", "ambient-gateway");
    const { auth } = await createFileBackedAuthService({
      "cloudflare-ai-gateway": { type: "api_key", key: "legacy-secret" },
    });

    const response = await auth.authProviders("login", "api_key");

    expect(response.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: "cloudflare-ai-gateway",
        loginFlow: "interactive",
        status: { configured: true, source: "stored" },
      }),
    ]));
    auth.dispose();
  });

  it("rejects unknown providers before starting API-key login", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService();
    const login = vi.spyOn(runtime, "login");

    await expect(auth.startApiKeyLogin("unknown-provider")).rejects.toThrow(
      "API key provider not found: unknown-provider",
    );

    expect(login).not.toHaveBeenCalled();
    await expect(credentials.read("unknown-provider")).resolves.toBeUndefined();
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it("rejects ambient-only providers before starting API-key login", async () => {
    const { auth, runtime, credentials, changes } = await createAuthService();
    const providers = [...runtime.getProviders()];
    const interactiveProvider = providers.find((provider) => provider.auth.apiKey?.login !== undefined);
    if (interactiveProvider?.auth.apiKey === undefined) throw new Error("Expected an interactive API-key provider");
    const ambientApiKey = { ...interactiveProvider.auth.apiKey };
    delete ambientApiKey.login;
    const ambientProvider = {
      ...interactiveProvider,
      id: "ambient-only",
      name: "Ambient Only",
      auth: { apiKey: ambientApiKey },
    };
    vi.spyOn(runtime, "getProviders").mockReturnValue([...providers, ambientProvider]);
    const login = vi.spyOn(runtime, "login");

    await expect(auth.startApiKeyLogin("ambient-only")).rejects.toThrow(
      "Ambient Only does not support interactive API-key setup",
    );

    expect(login).not.toHaveBeenCalled();
    await expect(credentials.read("ambient-only")).resolves.toBeUndefined();
    expect(changes).toEqual([]);
    auth.dispose();
  });

  it("reloads models.json before enumerating and validating OAuth providers", async () => {
    const agentDir = await tempAgentDir();
    const modelsPath = join(agentDir, "models.json");
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath,
      allowModelNetwork: false,
    });
    const authFlows = new CapturingOAuthLoginFlowService();
    const auth = await AuthService.create({ runtime, authFlows });

    await writeFile(modelsPath, radiusModelsConfig("First Radius"));
    const response = await auth.authProviders("login", "oauth");
    expect(response.providers).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "test-radius", name: "First Radius", authType: "oauth" }),
    ]));

    await writeFile(modelsPath, radiusModelsConfig("Updated Radius"));
    await expect(auth.startOAuthLogin("test-radius")).resolves.toMatchObject({
      providerId: "test-radius",
      providerName: "Updated Radius",
      status: "running",
    });
    expect(authFlows.startCalls.at(0)).toMatchObject({
      providerId: "test-radius",
      providerName: "Updated Radius",
      runtime,
    });
    auth.dispose();
  });

  it("stores credentials in the configured agent directory", async () => {
    const agentDir = await tempAgentDir();
    const runtime = await createModelRuntimeForAgentDir(agentDir);
    const auth = await AuthService.create({ runtime });

    const state = await auth.startApiKeyLogin("anthropic");
    if (state.prompt === undefined) throw new Error("Expected Anthropic key prompt");
    auth.respondToOAuthFlow(state.flowId, state.prompt.requestId, "sk-test");
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });

    await expect(readFile(join(agentDir, "auth.json"), "utf8")).resolves.toContain("sk-test");
    auth.dispose();
  });

  it("reconciles cancellation after ModelRuntime persists OAuth but before synchronization completes", async () => {
    const credentials = new PostCommitReadGateCredentialStore();
    const { auth, runtime, changes } = await createAuthServiceWithCredentials(credentials);
    const provider = runtime.getProviders().find((option) => option.id === "anthropic" && option.auth.oauth !== undefined);
    if (provider?.auth.oauth === undefined) throw new Error("Expected built-in OAuth provider");
    const credential: Credential = {
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60 * 60 * 1000,
    };
    vi.spyOn(provider.auth.oauth, "login").mockImplementation((interaction) => {
      interaction.notify({ type: "progress", message: "Credential received" });
      return Promise.resolve(credential);
    });

    const state = await auth.startOAuthLogin(provider.id);
    await credentials.synchronizationStarted.promise;

    await expect(credentials.readCommitted(provider.id)).resolves.toEqual(credential);
    expect(auth.cancelOAuthFlow(state.flowId)).toMatchObject({ status: "cancelled", error: "Login cancelled" });
    expect(changes).toEqual([]);

    credentials.finishSynchronization.resolve(undefined);
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });

    expect(auth.oauthFlow(state.flowId)).toMatchObject({ status: "complete", progress: ["Credential received", "Login complete"] });
    expect(auth.oauthFlow(state.flowId)).not.toHaveProperty("error");
    await expect(credentials.readCommitted(provider.id)).resolves.toEqual(credential);
    expect(changes).toEqual([{}]);
    auth.dispose();
  });

  it("reconciles a committed login synchronization failure once without logging credentials", async () => {
    const credentials = new PostCommitReadFailureCredentialStore();
    const logging = vi.fn();
    const { auth, runtime, changes } = await createAuthServiceWithCredentials(credentials, { error: logging });
    const provider = runtime.getProviders().find((option) => option.id === "anthropic" && option.auth.oauth !== undefined);
    if (provider?.auth.oauth === undefined) throw new Error("Expected built-in OAuth provider");
    const credential: Credential = {
      type: "oauth",
      refresh: "private-refresh-token",
      access: "private-access-token",
      expires: Date.now() + 60 * 60 * 1000,
    };
    credentials.failAfterNextModify(provider.id);
    vi.spyOn(provider.auth.oauth, "login").mockImplementation((interaction) => {
      interaction.notify({ type: "progress", message: "Credential received" });
      return Promise.resolve(credential);
    });

    const state = await auth.startOAuthLogin(provider.id);
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });

    await expect(credentials.read(provider.id)).resolves.toEqual(credential);
    expect(changes).toEqual([{}]);
    expect(logging).toHaveBeenCalledOnce();
    expect(logging).toHaveBeenCalledWith(
      {
        error: {
          name: "CredentialSynchronizationError",
          message: `Credential login committed for ${provider.id}, but local synchronization failed`,
        },
        flowId: state.flowId,
        operation: "login",
        providerId: provider.id,
      },
      "login credential synchronization failed after commit",
    );
    expect(JSON.stringify(logging.mock.calls)).not.toContain("private-refresh-token");
    expect(JSON.stringify(logging.mock.calls)).not.toContain("private-access-token");
    auth.dispose();
  });

  it("reconciles a committed logout synchronization failure once without logging credentials", async () => {
    const credentials = new PostCommitReadFailureCredentialStore();
    await credentials.modify("anthropic", () => Promise.resolve({ type: "api_key", key: "private-api-key" }));
    const logging = vi.fn();
    const { auth, changes } = await createAuthServiceWithCredentials(credentials, { error: logging });
    credentials.failAfterNextDelete("anthropic");

    await expect(auth.logoutProvider("anthropic")).resolves.toEqual({ accepted: true });

    await expect(credentials.read("anthropic")).resolves.toBeUndefined();
    expect(changes).toEqual([{ removedProviderId: "anthropic" }]);
    expect(logging).toHaveBeenCalledOnce();
    expect(logging).toHaveBeenCalledWith(
      {
        error: {
          name: "CredentialSynchronizationError",
          message: "Credential logout committed for anthropic, but local synchronization failed",
        },
        operation: "logout",
        providerId: "anthropic",
      },
      "credential synchronization failed after commit",
    );
    expect(JSON.stringify(logging.mock.calls)).not.toContain("private-api-key");
    auth.dispose();
  });

  it("emits an auth change once after the injected OAuth flow completes", async () => {
    const runtime = await ModelRuntime.create({
      credentials: new InMemoryCredentialStore(),
      modelsPath: null,
      allowModelNetwork: false,
    });
    const authFlows = new CapturingOAuthLoginFlowService();
    const auth = await AuthService.create({ runtime, authFlows });
    const changes: AuthChange[] = [];
    auth.subscribe((change) => { changes.push(change); });
    const provider = runtime.getProviders().find((option) => option.id === "anthropic" && option.auth.oauth !== undefined);
    if (provider === undefined) throw new Error("Expected built-in OAuth provider");

    await expect(auth.startOAuthLogin(provider.id)).resolves.toMatchObject({ providerId: provider.id, providerName: provider.name, status: "running" });

    const startOptions = authFlows.startCalls.at(0);
    if (startOptions === undefined) throw new Error("Expected OAuth flow to start");
    expect(startOptions.providerId).toBe(provider.id);
    expect(startOptions.providerName).toBe(provider.name);
    expect(startOptions.runtime).toBe(runtime);
    expect(changes).toEqual([]);

    if (startOptions.onComplete === undefined) throw new Error("Expected OAuth completion callback");
    await startOptions.onComplete();
    expect(changes).toEqual([{}]);

    auth.dispose();
    expect(authFlows.disposed).toBe(true);
  });

  it("completes OAuth when an auth-change listener and failure logging throw", async () => {
    const loggingFailure = new Error("auth logger failed");
    const error = vi.fn(() => { throw loggingFailure; });
    const logger: AuthServiceLogger = { error };
    const { auth, runtime, changes } = await createAuthService({}, logger);
    const provider = runtime.getProviders().find((option) => option.id === "anthropic" && option.auth.oauth !== undefined);
    if (provider === undefined) throw new Error("Expected built-in OAuth provider");
    vi.spyOn(runtime, "login").mockResolvedValue({
      type: "oauth",
      refresh: "refresh-token",
      access: "access-token",
      expires: Date.now() + 60_000,
    });
    const failure = new Error("session OAuth refresh failed");
    auth.subscribe(() => Promise.reject(failure));

    const state = await auth.startOAuthLogin(provider.id);
    await vi.waitFor(() => { expect(auth.oauthFlow(state.flowId).status).toBe("complete"); });

    expect(changes).toEqual([{}]);
    expect(error).toHaveBeenCalledWith(
      { err: failure, operation: "login", providerId: provider.id, authType: "oauth" },
      "auth-change listener failed",
    );
    auth.dispose();
  });
});

describe("createModelRuntimeForAgentDir", () => {
  it("keeps implicit catalog refreshes local while allowing explicit network refreshes", async () => {
    vi.stubEnv("PI_OFFLINE", undefined);
    const agentDir = await tempAgentDir();
    await writeFile(join(agentDir, "auth.json"), JSON.stringify({ anthropic: { type: "api_key", key: "catalog-test-key" } }));
    const runtime = await createModelRuntimeForAgentDir(agentDir);
    const fetch = vi.spyOn(globalThis, "fetch").mockImplementation(() => Promise.resolve(new Response(null, { status: 404 })));
    try {
      await runtime.refresh({ force: true });
      expect(fetch).not.toHaveBeenCalled();

      await runtime.refresh({ allowNetwork: true, force: true });
      expect(fetch).toHaveBeenCalled();
    } finally {
      fetch.mockRestore();
    }
  });

  it("restores a previously set PI_OFFLINE after runtime creation", async () => {
    // The file-level beforeEach stubs PI_OFFLINE=1.
    const agentDir = await tempAgentDir();
    await createModelRuntimeForAgentDir(agentDir);
    expect(process.env["PI_OFFLINE"]).toBe("1");
  });

  it("restores a previously unset PI_OFFLINE after runtime creation", async () => {
    vi.unstubAllEnvs();
    const previous = process.env["PI_OFFLINE"];
    delete process.env["PI_OFFLINE"];
    try {
      const agentDir = await tempAgentDir();
      let observed: string | undefined;
      await createModelRuntimeForAgentDir(agentDir, (options) => {
        observed = process.env["PI_OFFLINE"];
        return ModelRuntime.create({ ...options, modelsPath: null, refreshOnCreate: false });
      });

      expect(observed).toBe("1");
      expect(process.env["PI_OFFLINE"]).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env["PI_OFFLINE"] = previous;
    }
  });

  it("restores PI_OFFLINE when creations overlap, because the env windows are serialized", async () => {
    vi.unstubAllEnvs();
    const previous = process.env["PI_OFFLINE"];
    delete process.env["PI_OFFLINE"];
    try {
      const dirs = await Promise.all([tempAgentDir(), tempAgentDir(), tempAgentDir()]);
      const firstEntered = deferred<undefined>();
      const releaseFirst = deferred<undefined>();
      const observations: (string | undefined)[] = [];
      let active = 0;
      let maxActive = 0;
      const createRuntime = async (options: CreateModelRuntimeOptions): Promise<ModelRuntime> => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        observations.push(process.env["PI_OFFLINE"]);
        if (observations.length === 1) {
          firstEntered.resolve(undefined);
          await releaseFirst.promise;
        }
        const runtime = await ModelRuntime.create({ ...options, modelsPath: null, refreshOnCreate: false });
        active -= 1;
        return runtime;
      };
      const first = createModelRuntimeForAgentDir(dirs[0], createRuntime);
      await firstEntered.promise;
      const rest = dirs.slice(1).map((dir) => createModelRuntimeForAgentDir(dir, createRuntime));
      releaseFirst.resolve(undefined);
      await Promise.all([first, ...rest]);

      expect(observations).toEqual(["1", "1", "1"]);
      expect(maxActive).toBe(1);
      expect(process.env["PI_OFFLINE"]).toBeUndefined();
    } finally {
      if (previous !== undefined) process.env["PI_OFFLINE"] = previous;
    }
  });
});

async function createAuthService(seed: Record<string, Credential> = {}, logger?: AuthServiceLogger) {
  const credentials = new InMemoryCredentialStore();
  for (const [providerId, credential] of Object.entries(seed)) {
    await credentials.modify(providerId, () => Promise.resolve(credential));
  }
  return createAuthServiceWithCredentials(credentials, logger);
}

async function createAuthServiceWithCredentials(
  credentials: InMemoryCredentialStore,
  logger?: AuthServiceLogger,
) {
  const runtime = await ModelRuntime.create({ credentials, modelsPath: null, allowModelNetwork: false });
  const auth = await AuthService.create({ runtime, ...(logger === undefined ? {} : { logger }) });
  const changes: AuthChange[] = [];
  auth.subscribe((change) => { changes.push(change); });
  return { auth, runtime, credentials, changes };
}

async function createFileBackedAuthService(seed: Record<string, Credential>) {
  const agentDir = await tempAgentDir();
  const authPath = join(agentDir, "auth.json");
  await writeFile(authPath, JSON.stringify(seed, null, 2));
  const runtime = await createModelRuntimeForAgentDir(agentDir);
  const auth = await AuthService.create({ runtime });
  const changes: AuthChange[] = [];
  auth.subscribe((change) => { changes.push(change); });
  return { auth, runtime, authPath, changes };
}

async function tempAgentDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "pi-web-auth-agent-"));
  tempDirs.push(dir);
  return dir;
}

function deferred<T>() {
  let resolveValue: (value: T) => void = () => undefined;
  let rejectValue: (reason?: unknown) => void = () => undefined;
  const promise = new Promise<T>((resolve, reject) => {
    resolveValue = resolve;
    rejectValue = reject;
  });
  return { promise, resolve: resolveValue, reject: rejectValue };
}

function radiusModelsConfig(name: string): string {
  return JSON.stringify({
    providers: {
      "test-radius": {
        name,
        baseUrl: "https://radius.example.test/v1",
        oauth: "radius",
      },
    },
  });
}

class CapturingOAuthLoginFlowService extends OAuthLoginFlowService {
  readonly startCalls: Parameters<OAuthLoginFlowService["start"]>[0][] = [];
  disposed = false;

  override start(options: Parameters<OAuthLoginFlowService["start"]>[0]): OAuthFlowState {
    this.startCalls.push(options);
    return { flowId: "flow-1", providerId: options.providerId, providerName: options.providerName, status: "running", progress: [] };
  }

  override waitForFirstObservableState(): Promise<OAuthFlowState> {
    const options = this.startCalls.at(-1);
    if (options === undefined) return Promise.reject(new Error("Expected OAuth flow to start"));
    return Promise.resolve({
      flowId: "flow-1",
      providerId: options.providerId,
      providerName: options.providerName,
      status: "running",
      progress: [],
    });
  }

  override dispose(): void {
    this.disposed = true;
  }
}

class PostCommitReadGateCredentialStore extends InMemoryCredentialStore {
  readonly synchronizationStarted = deferred<undefined>();
  readonly finishSynchronization = deferred<undefined>();
  private committedProviderId: string | undefined;
  private gated = false;

  override async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const credential = await super.modify(providerId, fn, options);
    this.committedProviderId = providerId;
    return credential;
  }

  override async read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (!this.gated && providerId === this.committedProviderId) {
      this.gated = true;
      this.synchronizationStarted.resolve(undefined);
      await this.finishSynchronization.promise;
    }
    return super.read(providerId, options);
  }

  readCommitted(providerId: string): Promise<Credential | undefined> {
    return super.read(providerId);
  }
}

class PostCommitReadFailureCredentialStore extends InMemoryCredentialStore {
  private armed: { operation: "modify" | "delete"; providerId: string } | undefined;
  private committed = false;
  private failed = false;

  failAfterNextModify(providerId: string): void {
    this.arm("modify", providerId);
  }

  failAfterNextDelete(providerId: string): void {
    this.arm("delete", providerId);
  }

  override async modify(
    providerId: string,
    fn: (current: Credential | undefined) => Promise<Credential | undefined>,
    options?: AuthOperationOptions,
  ): Promise<Credential | undefined> {
    const credential = await super.modify(providerId, fn, options);
    if (this.armed?.operation === "modify" && this.armed.providerId === providerId) this.committed = true;
    return credential;
  }

  override async delete(providerId: string, options?: AuthOperationOptions): Promise<void> {
    await super.delete(providerId, options);
    if (this.armed?.operation === "delete" && this.armed.providerId === providerId) this.committed = true;
  }

  override read(providerId: string, options?: AuthOperationOptions): Promise<Credential | undefined> {
    if (this.committed && !this.failed && this.armed?.providerId === providerId) {
      this.failed = true;
      return Promise.reject(new Error("Injected post-commit synchronization failure"));
    }
    return super.read(providerId, options);
  }

  private arm(operation: "modify" | "delete", providerId: string): void {
    this.armed = { operation, providerId };
    this.committed = false;
    this.failed = false;
  }
}
