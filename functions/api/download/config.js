import { downloadHandlers } from '../../../website/download-verification.mjs';

export function onRequest({ request, env }) {
  return downloadHandlers.config(request, env);
}
