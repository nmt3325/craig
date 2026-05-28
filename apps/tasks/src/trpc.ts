import * as trpc from '@trpc/server';
import { createHTTPServer } from '@trpc/server/adapters/standalone';
import { z } from 'zod';

import { driveUpload } from './queries/driveUpload';
import { notionUpload } from './queries/notionUpload';
import { transcribeUpload } from './queries/transcribeUpload';

export const appRouter = trpc
  .router()
  .query('driveUpload', {
    input: z.object({
      recordingId: z.string(),
      userId: z.string()
    }),
    resolve: async ({ input }) => {
      return await driveUpload(input);
    }
  })
  .query('notionUpload', {
    input: z.object({
      recordingId: z.string(),
      channelId: z.string(),
      userId: z.string()
    }),
    resolve: async ({ input }) => {
      return await notionUpload(input);
    }
  })
  .query('transcribeUpload', {
    input: z.object({
      recordingId: z.string(),
      channelId: z.string(),
      userId: z.string(),
      lang: z.string().optional(),
      notionPageId: z.string().optional()
    }),
    resolve: async ({ input }) => {
      return await transcribeUpload(input);
    }
  });

export type AppRouter = typeof appRouter;

const { server, listen } = createHTTPServer({
  router: appRouter,
  createContext() {
    return {};
  }
});

export { listen, server };
