import { NextRequest, NextResponse } from 'next/server';

const CONTROL_PLANE_URL = process.env.CONTROL_PLANE_URL ?? 'http://127.0.0.1:8081';
const ADMIN_TOKEN = process.env.ADMIN_API_TOKEN ?? '';

export async function POST(req: NextRequest) {
  const path = req.nextUrl.searchParams.get('path');
  const method = (req.nextUrl.searchParams.get('method') ?? 'POST').toUpperCase();
  if (!path || !path.startsWith('/admin/')) {
    return NextResponse.json({ error: 'invalid path' }, { status: 400 });
  }

  const res = await fetch(`${CONTROL_PLANE_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${ADMIN_TOKEN}`,
      'Content-Type': 'application/json',
    },
  });

  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }

  // Redirect back to referer for form posts
  const referer = req.headers.get('referer');
  if (referer) {
    return NextResponse.redirect(referer, 303);
  }
  return NextResponse.json(body, { status: res.status });
}
