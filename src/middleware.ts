import { defineMiddleware } from 'astro:middleware';
import { findUser } from './lib/db.mjs';
export const onRequest = defineMiddleware(async (context, next) => {
  const { pathname } = context.url;
  const userId = context.cookies.get('chat_user_id')?.value;
  context.locals.user = userId && userId !== 'system' ? await findUser(userId) : null;
  if (pathname !== '/join' && pathname !== '/api/join' && !context.locals.user) return context.redirect('/join', 303);
  if (context.request.method !== 'GET' && context.request.method !== 'HEAD') {
    const origin = context.request.headers.get('origin');
    const allowed = process.env.APP_ORIGIN || context.url.origin;
    if (!origin || origin !== allowed) return new Response('Invalid request origin', { status: 403 });
  }
  const response = await next();
  response.headers.set('X-Content-Type-Options', 'nosniff');
  response.headers.set('Referrer-Policy', 'same-origin');
  response.headers.set('Cache-Control', 'no-store');
  return response;
});
