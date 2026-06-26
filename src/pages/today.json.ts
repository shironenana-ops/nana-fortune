import type { APIRoute } from 'astro';
import { evaluate } from '../lib/shirone/engine';

export const GET: APIRoute = async ({ url }) => {
  const birth = url.searchParams.get('birth'); // 例: 1984-04-10
  const name  = url.searchParams.get('name') ?? '';
  const focus = (url.searchParams.get('focus') ?? '') as 'work' | 'love' | 'health' | '';

  if (!birth || !/^\d{4}-\d{2}-\d{2}$/.test(birth)) {
    return new Response(JSON.stringify({ error: 'birth(YYYY-MM-DD) を指定してください' }), {
      status: 400,
      headers: { 'content-type': 'application/json; charset=utf-8' }
    });
  }

  const result = evaluate({
    birthISO: birth,
    name,
    focus: focus || undefined,
    detail: true, // 詳細込み
  });

  return new Response(JSON.stringify(result), {
    status: 200,
    headers: {
      'content-type': 'application/json; charset=utf-8',
      'cache-control': 'no-store'
    }
  });
};
