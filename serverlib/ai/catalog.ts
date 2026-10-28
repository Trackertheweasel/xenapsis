import { AiError, DEFAULT_MODEL } from './index';
import type { AiConfig, ChatProvider, ModelInfo } from './index';

// The models people can pick, fetched from the provider and kept for a while instead of asked for
// on every page load. Which free models exist changes over time, so nothing here names one: the
// list is whatever OpenRouter says today, with its "openrouter/free" router always first.

const TTL_MS = 10 * 60 * 1000;
// After a failed fetch, wait this long before asking again, so an outage isn't hammered.
const RETRY_MS = 30 * 1000;

export const FREE_ROUTER: ModelInfo = {
  id: DEFAULT_MODEL,
  name: 'OpenRouter Free',
  provider: 'OpenRouter',
  contextLength: null,
  free: true,
};

export class ModelCatalog {
  private models: ModelInfo[] | null = null;
  private fetchedAt = 0;
  private failedAt = 0;
  private pending: Promise<ModelInfo[]> | null = null;

  constructor(
    private readonly provider: ChatProvider,
    private readonly config: Pick<AiConfig, 'allowedModels' | 'defaultModel'>,
  ) {}

  private allowed(m: ModelInfo): boolean {
    const { allowedModels, defaultModel } = this.config;
    if (m.id === defaultModel) return true;
    if (allowedModels === 'all') return true;
    if (allowedModels === 'free') return m.free;
    return allowedModels.has(m.id);
  }

  // The list for the picker. Serves a stale copy if a refresh fails; throws only with nothing cached.
  async list(now = Date.now()): Promise<ModelInfo[]> {
    if (this.models && now - this.fetchedAt < TTL_MS) return this.models;
    if (!this.pending && now - this.failedAt >= RETRY_MS) {
      this.pending = this.provider
        .listModels()
        .then(raw => {
          const byId = new Map(raw.map(m => [m.id, m]));
          byId.delete(FREE_ROUTER.id);
          const models = [FREE_ROUTER, ...byId.values()].filter(m => this.allowed(m));
          // A default the provider doesn't list (a new model, a typo) is still offered, so the
          // page's default choice exists in the picker; the provider decides if it works.
          if (!models.some(m => m.id === this.config.defaultModel)) {
            models.unshift({
              ...FREE_ROUTER,
              id: this.config.defaultModel,
              name: this.config.defaultModel,
              provider: '',
              free: false,
            });
          }
          this.models = models;
          this.fetchedAt = Date.now();
          return models;
        })
        .catch(err => {
          this.failedAt = Date.now();
          throw err;
        })
        .finally(() => {
          this.pending = null;
        });
    }
    if (this.pending) {
      try {
        return await this.pending;
      } catch (err) {
        if (this.models) return this.models;
        throw err;
      }
    }
    if (this.models) return this.models;
    throw new AiError('upstream_unavailable');
  }

  // Whether a chat may use this model. Checked against the provider's list when there is one;
  // while it can't be fetched, only what the allowed-models setting permits on its own.
  async check(id: string): Promise<void> {
    const { allowedModels, defaultModel } = this.config;
    if (id === defaultModel || (id === FREE_ROUTER.id && this.allowed(FREE_ROUTER))) return;
    if (allowedModels instanceof Set) {
      if (allowedModels.has(id)) return;
      throw new AiError('invalid_model');
    }
    let models: ModelInfo[] | null = null;
    try {
      models = await this.list();
    } catch {}
    if (models) {
      if (models.some(m => m.id === id)) return;
      throw new AiError('invalid_model');
    }
    // No list to check against: a free-only server still only takes models marked free in the ID.
    if (allowedModels === 'free' && !id.endsWith(':free')) throw new AiError('invalid_model');
  }
}
