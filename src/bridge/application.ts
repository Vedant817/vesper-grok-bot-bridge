import { z } from 'zod';
import { bridgeConfigSchema, t3ConnectionSchema } from './config.js';
import { BridgeService } from './service.js';
import { discoverProviders } from './provider.js';
import { discoverT3Providers } from './t3-provider.js';
import { Redactor } from '../safety.js';
import type { Services } from '../server.js';
import { TaskRouter } from './router.js';

export const bridgeOwnerSchema = bridgeConfigSchema.extend({
  providers: z.record(z.string(), z.object({ executable: z.string().min(1), args: z.array(z.string()).optional(), models: z.array(z.string()).optional(), env: z.record(z.string(), z.string()).optional(), protocol: z.enum(['acp', 'codex', 'claude']).optional(), authMethodId: z.string().min(1).max(200).optional() }).strict().superRefine((provider, context) => {
    if (provider.authMethodId && provider.protocol !== 'acp') context.addIssue({ code: 'custom', path: ['authMethodId'], message: 'Native authMethodId requires explicit ACP protocol' });
  })).default({}),
  t3: t3ConnectionSchema.optional()
}).strict();

export async function bridgeApplication(input: unknown): Promise<Services & { bridge: BridgeService }> {
  const { providers: overrides, t3, ...config } = bridgeOwnerSchema.parse(input);
  const secrets = Object.values(overrides).flatMap(p => Object.values(p.env ?? {}));
  secrets.push(...config.roots.flatMap(r => Object.values(r.verify.env ?? {})));
  secrets.push(process.env.MCP_SERVER_TOKEN ?? '', process.env.T3_BEARER_TOKEN ?? '', t3?.tokenEnv ? process.env[t3.tokenEnv] ?? '' : '');
  const redactor = new Redactor(secrets);
  const providers = await discoverProviders(overrides);
  if (t3) providers.push(...await discoverT3Providers(t3));
  const bridge = await BridgeService.create(config, providers, redactor);
  try {
    const router = await TaskRouter.create(bridge, config.stateDirectory);
    return { repository: config.roots[0].directory, redactor, bridge, router };
  } catch (error) { await bridge.close(); throw error; }
}
