/**
 * OpenCode v2 server entry for opencode-prompts.
 *
 * Loads the user definition through the public promise plugin API:
 * `session.prompt` admission guard, one late disposable `agent.transform`
 * seed, and a `session.context` renderer. The entry itself never reads the
 * definition; the runtime does, fresh on every admission and request.
 */
import { Agent, Plugin } from '@opencode/plugin';
import { PromptsRuntime, type AgentEditor, type ModelRefLike, type RuntimeHost } from './runtime.ts';

export default Plugin.define({
  id: 'opencode-prompts',
  async setup(ctx) {
    const runtime = new PromptsRuntime(createHost(ctx), ctx.options);
    return runtime.start();
  },
});

function createHost(ctx: Plugin.Context): RuntimeHost {
  return {
    directory: ctx.location.directory,
    transformAgents: (callback) =>
      ctx.agent.transform((editor) => {
        callback(editorView(editor));
      }),
    reloadAgents: () => ctx.agent.reload(),
    onPrompt: (callback) =>
      ctx.session.hook('prompt', (event) =>
        callback({
          sessionID: event.sessionID,
        }),
      ),
    onContext: (callback) =>
      ctx.session.hook('context', (event) =>
        callback({
          sessionID: event.sessionID,
          agent: event.agent,
          model: event.model,
          system: event.system,
          tools: event.tools,
        }),
      ),
    listAgents: async () => {
      const response = await ctx.agent.list();
      return response.data.map((agent) => ({
        id: agent.id,
        model: agent.model,
        system: agent.system,
      }));
    },
    getSession: async (sessionID) => {
      const session = await ctx.session.get({ sessionID });
      return {
        agent: session.agent,
        model: session.model,
      };
    },
    defaultModel: async () => {
      const response = await ctx.model.default();
      const model = response.data;
      if (model === null) return undefined;
      return {
        id: model.id,
        providerID: model.providerID,
        package: model.package,
        capabilities: model.capabilities,
      };
    },
    listModels: async () => {
      const response = await ctx.model.list();
      return response.data.map((model) => ({
        id: model.id,
        providerID: model.providerID,
        package: model.package,
        capabilities: model.capabilities,
      }));
    },
    listTools: async () => {
      const tools = await ctx.tool.list();
      return tools.map((tool) => ({
        name: tool.id,
        description: tool.description,
        input: tool.input,
      }));
    },
  };
}

type HostEditor = Parameters<Parameters<Plugin.Context['agent']['transform']>[0]>[0];
type HostAgentInfo = ReturnType<HostEditor['list']>[number];

interface ViewAgent {
  readonly id: string;
  readonly model?: ModelRefLike;
  system?: string;
}

function editorView(editor: HostEditor): AgentEditor {
  return {
    list: () => editor.list().map(readAgent),
    update: (id, update) => {
      editor.update(Agent.ID.make(id), (agent) => {
        const view: ViewAgent = readAgent(agent);
        update(view);
        agent.system = view.system;
      });
    },
  };
}

/**
 * DeepMutable maps branded schema strings into struct types, so identities are
 * read back through String() at the host boundary instead of being trusted.
 */
function readAgent(agent: HostAgentInfo): ViewAgent {
  const model = agent.model;
  return {
    id: String(agent.id),
    ...(model === undefined
      ? {}
      : {
          model: {
            id: String(model.id),
            providerID: String(model.providerID),
            ...(model.variant === undefined ? {} : { variant: String(model.variant) }),
          },
        }),
    system: agent.system,
  };
}
