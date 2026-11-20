import type { FastifyInstance } from '../http';
import { z } from 'zod';
import { ANDROID_NAMES, sdkManager } from '../automation/sdk-manager';
import { deviceInput, deviceRepo } from '../services/devices';

const installBody = z.object({
  package: z.string().min(1).max(120),
  accept_licenses: z.literal(true, { errorMap: () => ({ message: 'You must accept the Android SDK license to download system images' }) }),
  force: z.boolean().optional(),
});

const avdBody = z.object({
  name: z.string().min(1).max(80),
  package: z.string().min(1).max(120),
  device: z.string().min(1).max(60),
  create_profile: z.boolean().default(true),
  ram_mb: z.number().int().min(1024).max(8192).optional(),
});

export async function sdkRoutes(app: FastifyInstance) {
  app.get('/sdk/images/installed', async () => ({ images: await sdkManager.installedImagesWithSize() }));

  app.get<{ Querystring: { refresh?: string } }>('/sdk/images', async (req) => ({
    images: await sdkManager.catalog(req.query.refresh === 'true'),
  }));

  app.get('/sdk/device-definitions', async () => ({ definitions: await sdkManager.deviceDefinitions() }));

  app.get('/sdk/jobs', async () => sdkManager.jobs());

  app.get<{ Params: { id: string } }>('/sdk/jobs/:id', async (req, reply) => sdkManager.job(req.params.id) ?? reply.code(404).send({ error: 'Job not found' }));

  /** Download a system image in the background. Progress arrives as `sdk_job` SSE events. */
  app.post('/sdk/images/install', async (req, reply) => {
    const body = installBody.parse(req.body);
    reply.code(202);
    return sdkManager.installImage(body.package, { force: body.force });
  });

  /** Create an AVD from an installed image, optionally adding a matching device profile when it finishes. */
  app.post('/sdk/avds', async (req, reply) => {
    const body = avdBody.parse(req.body);
    const api = Number(body.package.match(/;android-(\d+)/)?.[1]) || null;
    const addProfile = () => {
      if (deviceRepo.list().some((d) => d.avd_name === body.name)) return;
      deviceRepo.create(
        deviceInput.parse({
          name: body.name.replace(/_/g, ' '),
          type: 'emulator',
          avd_name: body.name,
          api_level: api ?? undefined,
          android_version: api ? (ANDROID_NAMES[api] ?? undefined) : undefined,
          ram_mb: body.ram_mb,
          enabled: true,
        }),
      );
    };
    reply.code(202);
    return sdkManager.createAvd(body, body.create_profile ? addProfile : undefined);
  });

  app.delete<{ Params: { name: string } }>('/sdk/avds/:name', async (req) => sdkManager.deleteAvd(req.params.name));

  /** Reset an AVD to factory state — frees its user data, cache and fast-boot snapshot. */
  app.post<{ Params: { name: string } }>('/sdk/avds/:name/wipe', async (req) => sdkManager.wipeAvd(req.params.name));

  /** Delete an installed system image to free disk space (409 while AVDs use it, unless force). */
  app.post('/sdk/images/uninstall', async (req, reply) => {
    const body = z.object({ package: z.string().min(1).max(120), force: z.boolean().optional() }).parse(req.body);
    reply.code(202);
    return sdkManager.uninstallImage(body.package, { force: body.force });
  });

  /** Where AVDs live, their sizes, and free space on the AVD and SDK drives. */
  app.get('/sdk/storage', async () => sdkManager.storageInfo());

  const storageBody = z.object({
    avd_storage_dir: z.string().max(240).nullable(),
    move_existing: z.boolean().default(true),
  });
  app.put('/sdk/storage', async (req, reply) => {
    const body = storageBody.parse(req.body);
    const r = await sdkManager.setAvdStorage(body.avd_storage_dir, body.move_existing);
    if (r.job) reply.code(202);
    return r;
  });

  /** Move <sdk>\system-images to another drive (junction) — null moves it back into the SDK. */
  app.put('/sdk/storage/images', async (req, reply) => {
    const body = z.object({ dir: z.string().max(240).nullable() }).parse(req.body);
    const r = await sdkManager.setImagesStorage(body.dir);
    if (r.job) reply.code(202);
    return r;
  });
}
