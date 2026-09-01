// OpenFGA API service
import axios from 'axios';
import type { InternalAxiosRequestConfig, AxiosError } from 'axios';
import { dslToJson, jsonToDsl } from '../utils/modelConverter';
import { getApiToken } from './tokenStore';
import { isTokenServiceConfigured, refreshToken, getInFlight } from './TokenService';
import { getCurrentEnvironment, getCurrentEnvKey } from './environmentStore';
import { publishLatency, opFromUrl, type LatencyStatus } from './latencyBus';

// Augment axios' request config with the fields we attach on it: the single-flight
// retry flag (set in the 401 recovery path) and the timing marker used to emit
// latency samples.
declare module 'axios' {
  interface InternalAxiosRequestConfig {
    _retry?: boolean;
    metadata?: { startTime: number };
  }
}

const api = axios.create({
  headers: {
    'Accept': 'application/json',
    'Content-Type': 'application/json',
  },
});

// Emit a latency sample for a settled request. No-op if the request was never
// timing-stamped (e.g. a request that failed before the request interceptor ran).
function emitLatencySample(
  config: InternalAxiosRequestConfig | undefined,
  status: LatencyStatus,
  httpStatus?: number,
): void {
  if (!config?.metadata) return;
  const url = config.url;
  const storeMatch = url?.match(/\/stores\/([^/]+)/);
  publishLatency({
    op: opFromUrl(url),
    storeId: storeMatch ? storeMatch[1] : null,
    envKey: getCurrentEnvKey(),
    elapsedMs: performance.now() - config.metadata.startTime,
    status,
    httpStatus,
    ts: Date.now(),
  });
}

api.interceptors.request.use(async (reqConfig) => {
  // Target the active environment's OpenFGA API. Set per-request (not at
  // axios.create) so switching environments at runtime takes effect immediately.
  reqConfig.baseURL = getCurrentEnvironment().apiUrl || '/api';

  // Mark request start so the response/error interceptors can measure wall-clock
  // latency (network + auth + server). On a 401→refresh→retry the retried request
  // re-runs this interceptor, so the emitted sample reflects the retry, not the
  // throwaway 401 attempt.
  reqConfig.metadata = { startTime: performance.now() };

  // Gate startup requests: when the token service is configured but no token has
  // been fetched yet (or one is mid-flight), wait for it so the first requests
  // never go out unauthenticated and 401.
  if (isTokenServiceConfigured() && !getApiToken()) {
    try {
      await (getInFlight() ?? refreshToken());
    } catch {
      // Fall through unauthenticated; the response interceptor will surface the error.
    }
  }
  const token = getApiToken();
  if (token) {
    reqConfig.headers.Authorization = `Bearer ${token}`;
  }
  return reqConfig;
});

// Reactive recovery: on a 401 (e.g. hourly expiry), fetch a fresh token once and
// retry the original request. Single-flight refresh dedupes concurrent 401s.
api.interceptors.response.use(
  (response) => {
    emitLatencySample(response.config, 'ok', response.status);
    return response;
  },
  async (error: AxiosError) => {
    const original = error.config;
    if (
      error.response?.status === 401 &&
      isTokenServiceConfigured() &&
      original &&
      !original._retry
    ) {
      original._retry = true;
      try {
        await refreshToken();
      } catch {
        // Refresh failed — this request is done; record it as an error.
        emitLatencySample(original, 'error', error.response?.status);
        return Promise.reject(error);
      }
      // Retry: the retried request settles on its own and is recorded there, so
      // we deliberately do not emit a sample for the 401 attempt (avoids double
      // counting a single logical request).
      return api(original);
    }
    const status: LatencyStatus = error.code === 'ECONNABORTED' ? 'timeout' : 'error';
    emitLatencySample(original, status, error.response?.status);
    return Promise.reject(error);
  },
);

interface RelationshipTuple {
  user: string;
  relation: string;
  object: string;
  condition?: {
    name: string;
    context: Record<string, string | number | boolean>;
  };
}

/**
 * OpenFGA read-consistency preference. MINIMIZE_LATENCY (default) may serve
 * cached/slightly-stale results; HIGHER_CONSISTENCY bypasses the check-query
 * cache and always resolves fresh (slower). Used by the benchmark's cold mode.
 */
export type Consistency = 'MINIMIZE_LATENCY' | 'HIGHER_CONSISTENCY' | 'UNSPECIFIED';

export interface CheckOptions {
  authorizationModelId?: string;
  consistency?: Consistency;
  /** Condition/cache-bust context passed through to the check. */
  context?: Record<string, string | number | boolean>;
}

/** Error-surfacing result of a single check — distinguishes errors from denials. */
export interface CheckRawResult {
  /** Present only when the request succeeded. */
  allowed?: boolean;
  httpStatus?: number;
  /** Present when the request failed (network/timeout/HTTP error). */
  error?: string;
  /** True when the failure was a client-side timeout (ECONNABORTED). */
  timedOut?: boolean;
}

export interface BatchCheckItem {
  user: string;
  relation: string;
  object: string;
  correlationId: string;
  context?: Record<string, string | number | boolean>;
}

/** Per-item batch-check outcome, keyed back to the caller's correlationId. */
export interface BatchCheckItemResult {
  correlationId: string;
  allowed?: boolean;
  error?: string;
}

export type HealthStatus = 'serving' | 'unhealthy' | 'unknown';

export class OpenFGAService {
  /**
   * Probe the OpenFGA server's `/healthz` endpoint. Uses a plain fetch (not the
   * authenticated `api` instance) so it reflects raw reachability even when the
   * token flow fails. `/healthz` is unauthenticated and returns `{status:"SERVING"}`.
   * Note: OpenFGA does not expose its build version over the API — only health.
   */
  static async getHealth(signal?: AbortSignal): Promise<HealthStatus> {
    try {
      const base = getCurrentEnvironment().apiUrl || '/api';
      const res = await fetch(`${base.replace(/\/$/, '')}/healthz`, {
        headers: { Accept: 'application/json' },
        signal,
      });
      if (!res.ok) return 'unhealthy';
      const data = (await res.json().catch(() => null)) as { status?: string } | null;
      return data?.status === 'SERVING' ? 'serving' : 'unhealthy';
    } catch {
      return 'unknown';
    }
  }

  static async createStore(name: string): Promise<{ id: string; name: string }> {
    try {
      const response = await api.post('/stores', { name });
      return response.data;
    } catch (error) {
      console.error('Failed to create store:', error);
      throw error;
    }
  }

  static async deleteStore(storeId: string): Promise<void> {
    try {
      await api.delete(`/stores/${storeId}`);
    } catch (error) {
      console.error('Failed to delete store:', error);
      throw error;
    }
  }

  static async listStores(): Promise<Array<{ id: string; name: string }>> {
    try {
      const response = await api.get('/stores');
      if (!response.data) {
        throw new Error('No data received from the API');
      }
      const stores = response.data.stores;
      if (!Array.isArray(stores)) {
        throw new Error('Invalid response format: stores is not an array');
      }
      return stores.map(store => ({
        id: store.id,
        name: store.name || `Store ${store.id}`
      }));
    } catch (error) {
      console.error('Failed to list stores:', error);
      throw error; // Let the component handle the error
    }
  }

  static async writeAuthorizationModel(storeId: string, model: string): Promise<{ authorization_model_id: string }> {
    try {
      // Convert DSL to JSON if it's not already in JSON format
      let jsonModel = model;
      if (!model.trim().startsWith('{')) {
        jsonModel = JSON.stringify(dslToJson(model));
      }
      
      const response = await api.post(`/stores/${storeId}/authorization-models`, jsonModel, {
        headers: {
          'Content-Type': 'application/json'
        }
      });
      return response.data;
    } catch (error) {
      console.error('Failed to write authorization model:', error);
      throw error;
    }
  }

  static async listTuples(storeId: string, options?: { page_size?: number; continuation_token?: string }): Promise<{ tuples: RelationshipTuple[]; continuation_token?: string }> {
    try {
      return await this.readFiltered(storeId, {
        page_size: options?.page_size,
        continuation_token: options?.continuation_token,
      });
    } catch (error) {
      console.error('Failed to list tuples:', error);
      return { tuples: [], continuation_token: undefined };
    }
  }

  static async readFiltered(
    storeId: string,
    options?: {
      user?: string;
      relation?: string;
      object?: string;
      page_size?: number;
      continuation_token?: string;
    }
  ): Promise<{ tuples: RelationshipTuple[]; continuation_token?: string }> {
    try {
      const tupleKey: { user?: string; relation?: string; object?: string } = {};
      if (options?.user) tupleKey.user = options.user;
      if (options?.relation) tupleKey.relation = options.relation;
      if (options?.object) tupleKey.object = options.object;

      const requestBody: {
        tuple_key?: typeof tupleKey;
        page_size?: number;
        continuation_token?: string;
      } = {};
      if (Object.keys(tupleKey).length > 0) requestBody.tuple_key = tupleKey;
      if (options?.page_size) requestBody.page_size = options.page_size;
      if (options?.continuation_token) requestBody.continuation_token = options.continuation_token;

      const response = await api.post(`/stores/${storeId}/read`, requestBody, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });

      interface TupleResponse {
        key: {
          user: string;
          relation: string;
          object: string;
          condition?: {
            name: string;
            context: Record<string, string | number | boolean>;
          };
        };
        timestamp: string;
      }

      const sortedTuples = [...(response.data.tuples || [])].sort((a: TupleResponse, b: TupleResponse) => {
        return new Date(b.timestamp).getTime() - new Date(a.timestamp).getTime();
      });

      const tuples = sortedTuples.map((tuple: TupleResponse) => ({
        user: tuple.key.user,
        relation: tuple.key.relation,
        object: tuple.key.object,
        condition: tuple.key.condition
      }));

      return { tuples, continuation_token: response.data.continuation_token };
    } catch (error) {
      console.error('Failed to read tuples:', error);
      throw error;
    }
  }

  static async listObjects(
    storeId: string,
    params: {
      user: string;
      relation: string;
      type: string;
      context?: Record<string, string | number | boolean>;
      authorizationModelId?: string;
      consistency?: Consistency;
    },
    options?: { timeoutMs?: number; signal?: AbortSignal }
  ): Promise<{ objects: string[] }> {
    try {
      const body: {
        user: string;
        relation: string;
        type: string;
        context?: Record<string, string | number | boolean>;
        authorization_model_id?: string;
        consistency?: Consistency;
      } = {
        user: params.user,
        relation: params.relation,
        type: params.type,
      };
      if (params.context && Object.keys(params.context).length > 0) {
        body.context = params.context;
      }
      if (params.authorizationModelId) {
        body.authorization_model_id = params.authorizationModelId;
      }
      if (params.consistency) {
        body.consistency = params.consistency;
      }

      const response = await api.post(`/stores/${storeId}/list-objects`, body, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json',
        },
        timeout: options?.timeoutMs,
        signal: options?.signal,
      });

      return { objects: response.data.objects || [] };
    } catch (error) {
      console.error('Failed to list objects:', error);
      throw error;
    }
  }

  static async writeTuple(storeId: string, tuple: RelationshipTuple, authModelId: string): Promise<void> {
    try {
      // Filter out empty condition parameters
      const condition = tuple.condition ? {
        name: tuple.condition.name,
        context: Object.fromEntries(
          Object.entries(tuple.condition.context)
            .filter(([, value]) => value !== undefined && value !== null && value !== '')
        )
      } : undefined;

      await api.post(`/stores/${storeId}/write`, {
        writes: {
          tuple_keys: [{
            user: tuple.user,
            relation: tuple.relation,
            object: tuple.object,
            ...(condition && Object.keys(condition.context).length > 0 ? { condition } : {})
          }]
        },
        authorization_model_id: authModelId
      }, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
    } catch (error) {
      console.error('Failed to write tuple:', error);
      throw error;
    }
  }

  static async deleteTuple(storeId: string, tuple: RelationshipTuple, authModelId: string): Promise<void> {
    try {
      await api.post(`/stores/${storeId}/write`, {
        deletes: {
          tuple_keys: [{
            user: tuple.user,
            relation: tuple.relation,
            object: tuple.object,
            ...(tuple.condition ? { condition: tuple.condition } : {})
          }]
        },
        authorization_model_id: authModelId
      }, {
        headers: {
          'Accept': 'application/json',
          'Content-Type': 'application/json'
        }
      });
    } catch (error) {
      console.error('Failed to delete tuple:', error);
      throw error;
    }
  }

  static async check(storeId: string, query: RelationshipTuple, authorizationModelId?: string): Promise<{ allowed: boolean }> {
    try {
      const response = await api.post(`/stores/${storeId}/check`, {
        tuple_key: {
          user: query.user,
          relation: query.relation,
          object: query.object
        },
        context: query.condition?.context,
        ...(authorizationModelId && { authorization_model_id: authorizationModelId })
      });
      return { allowed: response.data.allowed };
    } catch (error) {
      console.error('Check request failed:', error);
      return { allowed: false };
    }
  }

  /**
   * Error-surfacing single check for benchmarking. Unlike check(), this does NOT
   * swallow errors into { allowed: false } — a timing-out or 5xx request stays
   * distinguishable from a genuine deny, which matters when chasing 800ms–3s
   * outliers. Supports a per-request timeout, a consistency preference, and a
   * cache-bust context.
   */
  static async checkRaw(
    storeId: string,
    query: RelationshipTuple,
    options?: CheckOptions & { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<CheckRawResult> {
    try {
      const context = options?.context ?? query.condition?.context;
      const response = await api.post(
        `/stores/${storeId}/check`,
        {
          tuple_key: { user: query.user, relation: query.relation, object: query.object },
          ...(context && Object.keys(context).length > 0 ? { context } : {}),
          ...(options?.consistency ? { consistency: options.consistency } : {}),
          ...(options?.authorizationModelId
            ? { authorization_model_id: options.authorizationModelId }
            : {}),
        },
        { timeout: options?.timeoutMs, signal: options?.signal },
      );
      return { allowed: response.data.allowed, httpStatus: response.status };
    } catch (err) {
      const error = err as AxiosError;
      return {
        error:
          (error.response?.data as { message?: string } | undefined)?.message ||
          error.message,
        httpStatus: error.response?.status,
        timedOut: error.code === 'ECONNABORTED',
      };
    }
  }

  /**
   * Batch-check: resolve many checks in one request. Returns a per-item result
   * keyed by correlationId (allowed on success, error on per-item failure). The
   * OpenFGA batch-check response is a map keyed by correlation_id.
   */
  static async batchCheck(
    storeId: string,
    checks: BatchCheckItem[],
    options?: CheckOptions & { timeoutMs?: number; signal?: AbortSignal },
  ): Promise<BatchCheckItemResult[]> {
    const response = await api.post(
      `/stores/${storeId}/batch-check`,
      {
        checks: checks.map((c) => ({
          tuple_key: { user: c.user, relation: c.relation, object: c.object },
          correlation_id: c.correlationId,
          ...(c.context && Object.keys(c.context).length > 0 ? { context: c.context } : {}),
        })),
        ...(options?.consistency ? { consistency: options.consistency } : {}),
        ...(options?.authorizationModelId
          ? { authorization_model_id: options.authorizationModelId }
          : {}),
      },
      { timeout: options?.timeoutMs, signal: options?.signal },
    );

    const result: Record<string, { allowed?: boolean; error?: { message?: string } }> =
      response.data.result || {};
    return checks.map((c) => {
      const r = result[c.correlationId];
      return {
        correlationId: c.correlationId,
        allowed: r?.allowed,
        error: r?.error?.message,
      };
    });
  }

  static async listAuthorizationModels(storeId: string): Promise<Array<{ id: string; schemaVersion: string }>> {
    try {
      const response = await api.get(`/stores/${storeId}/authorization-models`);
      return response.data.authorization_models || [];
    } catch (error) {
      console.error('Failed to list authorization models:', error);
      return [];
    }
  }

  static async getAuthorizationModel(storeId: string, modelId?: string): Promise<{ model: string; modelId?: string }> {
    try {
      // If no modelId is provided, try to get the latest one
      if (!modelId) {
        const models = await this.listAuthorizationModels(storeId);
        modelId = models.length > 0 ? models[0].id : undefined;
      }

      if (!modelId) {
        return { model: '', modelId: undefined }; // No models exist yet
      }

      // Get the authorization model
      const response = await api.get(`/stores/${storeId}/authorization-models/${modelId}`);
      const authModel = response.data.authorization_model;

      // Convert JSON model to DSL format
      const dslModel = jsonToDsl(authModel);

      return {
        model: dslModel,
        modelId
      };
    } catch (error) {
      console.error('Failed to get authorization model:', error);
      return { model: '', modelId: undefined };
    }
  }

  /**
   * Fetch the authorization model as RAW JSON (schema_version + type_definitions
   * + conditions), NOT converted to DSL. Used for copying a model verbatim into
   * the benchmark store — the DSL round-trip in getAuthorizationModel is lossy for
   * conditions/metadata, so seeding must use this.
   */
  static async getAuthorizationModelRaw(
    storeId: string,
    modelId?: string,
  ): Promise<{ model: Record<string, unknown> | null; modelId?: string }> {
    if (!modelId) {
      const models = await this.listAuthorizationModels(storeId);
      modelId = models.length > 0 ? models[0].id : undefined;
    }
    if (!modelId) return { model: null, modelId: undefined };

    const response = await api.get(`/stores/${storeId}/authorization-models/${modelId}`);
    const m = response.data.authorization_model;
    return {
      model: {
        schema_version: m.schema_version,
        type_definitions: m.type_definitions,
        ...(m.conditions ? { conditions: m.conditions } : {}),
      },
      modelId,
    };
  }

  /** Write a raw model JSON object; returns the new authorization_model_id. */
  static async writeAuthorizationModelRaw(
    storeId: string,
    model: Record<string, unknown>,
  ): Promise<{ authorization_model_id: string }> {
    const response = await api.post(`/stores/${storeId}/authorization-models`, model);
    return response.data;
  }

  /** Batch-write tuples with on_duplicate:ignore (idempotent). */
  static async writeTuples(
    storeId: string,
    tuples: Array<{ user: string; relation: string; object: string }>,
    authModelId: string,
    batchSize = 40,
  ): Promise<number> {
    let written = 0;
    for (let i = 0; i < tuples.length; i += batchSize) {
      const batch = tuples.slice(i, i + batchSize);
      await api.post(`/stores/${storeId}/write`, {
        writes: { tuple_keys: batch, on_duplicate: 'ignore' },
        authorization_model_id: authModelId,
      });
      written += batch.length;
    }
    return written;
  }

  /**
   * Batch-delete tuples. Deleting a non-existent tuple errors, so each batch is
   * tolerated independently to keep teardown idempotent.
   */
  static async deleteTuples(
    storeId: string,
    tuples: Array<{ user: string; relation: string; object: string }>,
    authModelId?: string,
    batchSize = 40,
  ): Promise<number> {
    let deleted = 0;
    for (let i = 0; i < tuples.length; i += batchSize) {
      const batch = tuples.slice(i, i + batchSize);
      try {
        await api.post(`/stores/${storeId}/write`, {
          deletes: { tuple_keys: batch },
          ...(authModelId ? { authorization_model_id: authModelId } : {}),
        });
        deleted += batch.length;
      } catch (error) {
        console.warn('deleteTuples: batch failed (continuing):', error);
      }
    }
    return deleted;
  }
}
