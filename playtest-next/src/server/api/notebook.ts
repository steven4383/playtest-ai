import type { FastifyInstance } from '../http';
import { z } from 'zod';
import { allProjectItems, notebook, notebookInput } from '../services/notebook';

type P = { Params: { id: string } };
const id = (v: string) => {
  if (!/^[\w-]{1,64}$/.test(v)) throw Object.assign(new Error('Invalid id'), { statusCode: 400 });
  return v;
};

/** Notebook (quick notes) and the cross-project task overview. */
export async function notebookRoutes(app: FastifyInstance) {
  app.get('/notebook', async (req) => {
    const q = z.object({ q: z.string().max(200).optional(), project: z.string().regex(/^[\w-]{1,64}$/).optional() }).parse(req.query);
    return { notes: notebook.list(q) };
  });
  app.post('/notebook', async (req, reply) => {
    reply.code(201);
    return notebook.create(notebookInput.parse(req.body ?? {}));
  });
  app.patch<P>('/notebook/:id', async (req) => notebook.update(id(req.params.id), notebookInput.parse(req.body ?? {})));
  app.delete<P>('/notebook/:id', async (req) => notebook.remove(id(req.params.id)));

  app.get('/project-items', async (req) => ({ items: allProjectItems({ open: (req.query as { open?: string }).open === '1' }) }));
}
