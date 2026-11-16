import { existsSync } from 'node:fs';
import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import fastifyWebsocket from '@fastify/websocket';
import Fastify, { type FastifyError, type FastifyInstance } from 'fastify';
import { z, ZodError } from 'zod';
import {
  Controller,
  MirrorValidationError,
  NotConnectedError,
  NotFoundError,
} from '@open-zone/core';
import { listSerialPorts, type MonopriceEmulator } from '@open-zone/drivers';
import {
  MAX_VOLUME_OFFSET,
  PatchValidationError,
  PollingConfigSchema,
  QueueConfigSchema,
  validatePatch,
  type ControllerEvent,
} from '@open-zone/shared';

export interface AppOptions {
  controller: Controller;
  /** Present in --simulate mode; enables the simulated-keypad endpoint. */
  emulator?: MonopriceEmulator;
  /** Directory with the built UI (packages/ui/dist). */
  uiDir?: string;
  /** WebSocket heartbeat interval; dead clients (sleeping phones) are dropped. */
  heartbeatMs?: number;
}

const zoneParam = z.object({ id: z.coerce.number().int() });
const idParam = z.object({ id: z.string().min(1) });
const nameBody = z.object({ name: z.string().max(40).nullable() });
const configBody = z
  .object({ name: z.string().max(40).nullable().optional(), enabled: z.boolean().optional() })
  .strict();
const sourceBody = z
  .object({ name: z.string().max(40).nullable().optional(), enabled: z.boolean().optional() })
  .strict();
const followerInput = z.union([
  z.number().int(),
  z.object({
    zone: z.number().int(),
    volumeOffset: z.number().int().min(-MAX_VOLUME_OFFSET).max(MAX_VOLUME_OFFSET).optional(),
  }),
]);
const mirrorCreate = z.object({
  name: z.string().max(40).optional(),
  enabled: z.boolean().optional(),
  primary: z.number().int(),
  followers: z.array(followerInput),
});
const mirrorUpdate = mirrorCreate.partial();
const configPatch = z.object({
  home: z
    .object({ name: z.string().max(40).nullable().optional() })
    .strict()
    .optional(),
  polling: PollingConfigSchema.partial().optional(),
  queue: QueueConfigSchema.partial().optional(),
});
const keypadBody = z.object({
  zone: z.number().int(),
  patch: z.record(z.string(), z.union([z.number(), z.boolean()])).optional(),
  keypad: z.boolean().optional(),
});

export type ServerMessage =
  ControllerEvent | ({ type: 'snapshot' } & ReturnType<typeof snapshot>) | { type: 'pong' };

function snapshot(controller: Controller, simulator: boolean) {
  return {
    system: { ...controller.getSystem(), simulator },
    zones: controller.getZones(),
    sources: controller.getSources(),
    mirrors: controller.listMirrors(),
    config: controller.getConfig(),
  };
}

export async function buildApp(options: AppOptions): Promise<FastifyInstance> {
  const { controller, emulator } = options;
  const simulator = emulator !== undefined;
  const app = Fastify({ logger: false });
  await app.register(fastifyWebsocket);

  app.setErrorHandler((err: FastifyError | Error, _req, reply) => {
    if (err instanceof ZodError) {
      return reply.status(400).send({
        error: 'bad_request',
        message: 'Invalid request',
        issues: err.issues.map((i) => `${i.path.join('.') || 'body'}: ${i.message}`),
      });
    }
    if (err instanceof PatchValidationError) {
      return reply
        .status(400)
        .send({ error: 'bad_request', message: err.message, issues: err.issues });
    }
    if (err instanceof MirrorValidationError) {
      return reply
        .status(409)
        .send({ error: 'conflict', message: err.message, issues: err.issues });
    }
    if (err instanceof NotFoundError) {
      return reply.status(404).send({ error: 'not_found', message: err.message });
    }
    if (err instanceof NotConnectedError) {
      return reply.status(503).send({ error: 'not_connected', message: err.message });
    }
    const status = 'statusCode' in err && err.statusCode ? err.statusCode : 500;
    if (status >= 500) console.error(err);
    return reply.status(status).send({ error: 'error', message: err.message });
  });

  // Future auth hook: replace this no-op with API-key or session checks.
  app.addHook('onRequest', async () => {});

  await app.register(
    async (api) => {
      api.get('/system', async () => ({ ...controller.getSystem(), simulator }));
      api.get('/snapshot', async () => snapshot(controller, simulator));

      api.get('/zones', async () => controller.getZones());
      api.get('/zones/:id', async (req) => controller.getZone(zoneParam.parse(req.params).id));
      api.patch('/zones/:id', async (req) =>
        controller.setZone(zoneParam.parse(req.params).id, req.body),
      );
      api.post('/zones/:id/refresh', async (req) =>
        controller.refreshZone(zoneParam.parse(req.params).id, 'high'),
      );
      api.patch('/zones/:id/config', async (req) =>
        controller.updateZone(zoneParam.parse(req.params).id, configBody.parse(req.body)),
      );
      api.put('/zones/:id/name', async (req) =>
        controller.renameZone(zoneParam.parse(req.params).id, nameBody.parse(req.body).name),
      );

      api.get('/sources', async () => controller.getSources());
      api.patch('/sources/:id', async (req) =>
        controller.updateSource(zoneParam.parse(req.params).id, sourceBody.parse(req.body)),
      );
      api.put('/sources/:id/name', async (req) =>
        controller.updateSource(zoneParam.parse(req.params).id, nameBody.parse(req.body)),
      );

      api.get('/mirrors', async () => controller.listMirrors());
      api.get('/mirrors/:id', async (req) => controller.getMirror(idParam.parse(req.params).id));
      api.post('/mirrors', async (req, reply) => {
        const group = await controller.createMirror(mirrorCreate.parse(req.body));
        return reply.status(201).send(group);
      });
      api.patch('/mirrors/:id', async (req) =>
        controller.updateMirror(idParam.parse(req.params).id, mirrorUpdate.parse(req.body)),
      );
      api.delete('/mirrors/:id', async (req, reply) => {
        await controller.deleteMirror(idParam.parse(req.params).id);
        return reply.status(204).send();
      });

      api.get('/config', async () => controller.getConfig());
      api.patch('/config', async (req) => {
        const body = configPatch.parse(req.body);
        return controller.updateSettings({
          ...(body.home && { home: body.home }),
          ...(body.polling && { polling: body.polling }),
          ...(body.queue && { queue: body.queue }),
        });
      });

      // Web app manifest per design root, so a home-screen install reopens that design.
      api.get('/manifest.webmanifest', async (req, reply) => {
        const roots = ['/', '/studio/', '/console/', '/tiles/'];
        const q = req.query as { root?: string };
        const root = q.root && roots.includes(q.root) ? q.root : '/';
        const home = controller.getConfig().home.name;
        const label = home ?? 'open-zone';
        return reply.type('application/manifest+json').send({
          name: label,
          short_name: label.slice(0, 12),
          description: 'Multi-zone audio control',
          start_url: root,
          scope: root,
          display: 'standalone',
          background_color: '#0f1115',
          theme_color: '#0f1115',
          icons: [{ src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' }],
        });
      });

      api.get('/serial-ports', async () => (simulator ? [] : listSerialPorts()));

      api.post('/simulator/keypad', async (req, reply) => {
        if (!emulator)
          return reply.status(404).send({ error: 'not_found', message: 'Not in simulator mode' });
        const body = keypadBody.parse(req.body);
        if (body.patch)
          emulator.pressKeypad(body.zone, validatePatch(controller.model, body.patch));
        if (body.keypad !== undefined) emulator.setKeypadConnected(body.zone, body.keypad);
        return reply.status(204).send();
      });

      api.get('/events', { websocket: true }, (socket) => {
        const release = controller.addClient();
        let alive = true;
        const send = (msg: ServerMessage) => {
          if (socket.readyState === socket.OPEN) socket.send(JSON.stringify(msg));
        };
        send({ type: 'snapshot', ...snapshot(controller, simulator) });
        const unsubscribe = controller.bus.subscribe(send);
        const heartbeat = setInterval(() => {
          if (!alive) return socket.terminate();
          alive = false;
          socket.ping();
        }, options.heartbeatMs ?? 30_000);
        socket.on('pong', () => (alive = true));
        socket.on('message', (data) => {
          alive = true;
          if (String(data) === 'ping') send({ type: 'pong' });
        });
        socket.on('close', () => {
          clearInterval(heartbeat);
          unsubscribe();
          release();
        });
      });
    },
    { prefix: '/api/v1' },
  );

  const uiDir = options.uiDir;
  if (uiDir && existsSync(join(uiDir, 'index.html'))) {
    await app.register(fastifyStatic, { root: uiDir, prefix: '/' });
    app.setNotFoundHandler((req, reply) => {
      if (req.method !== 'GET' || req.url.startsWith('/api/')) {
        return reply.status(404).send({ error: 'not_found', message: `${req.method} ${req.url}` });
      }
      return reply.sendFile('index.html'); // SPA fallback
    });
  } else {
    app.get('/', async (_req, reply) =>
      reply
        .type('text/plain')
        .send('open-zone API is running, but the UI has not been built.\nRun: npm run build\n'),
    );
  }

  return app;
}
