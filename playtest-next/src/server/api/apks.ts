import type { FastifyInstance } from '../http';
import { bus } from '../core/events';
import { deleteApk, getApk, listApks, storeApk } from '../services/apks';

export async function apkRoutes(app: FastifyInstance) {
  app.post('/apks/upload', async (req, reply) => {
    const file = await req.file();
    if (!file) return reply.code(400).send({ error: 'Send the APK as multipart field "file"' });
    const apk = await storeApk(file.filename, file.file);
    bus.publish({ event: 'apk_uploaded', data: { apk_id: apk.id, package_name: apk.package_name } });
    reply.code(201);
    const { storage_path, ...pub } = apk;
    return pub;
  });

  app.get('/apks', async () => listApks());

  app.get<{ Params: { id: string } }>('/apks/:id', async (req, reply) => {
    const apk = getApk(req.params.id);
    if (!apk) return reply.code(404).send({ error: 'APK not found' });
    const { storage_path, ...pub } = apk;
    return pub;
  });

  app.delete<{ Params: { id: string } }>('/apks/:id', async (req, reply) => {
    if (!deleteApk(req.params.id)) return reply.code(404).send({ error: 'APK not found' });
    return reply.code(204).send();
  });
}
