import { NextResponse } from "next/server";
import { z } from "zod";
import {
  createSessionToken,
  getSessionCookieOptions,
  verifyAdminCredentials,
} from "@/lib/auth";

const loginSchema = z.object({
  username: z.string().min(1),
  password: z.string().min(1),
});

export async function POST(request: Request) {
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json({ error: "Username and password are required" }, { status: 400 });
  }

  const { username, password } = parsed.data;
  if (!verifyAdminCredentials(username, password)) {
    return NextResponse.json({ error: "Invalid credentials" }, { status: 401 });
  }

  const secret = process.env.SESSION_SECRET;
  if (!secret || secret.trim() === "") {
    return NextResponse.json(
      { error: "Server session configuration missing" },
      { status: 500 },
    );
  }

  const token = createSessionToken(username, secret);
  const response = NextResponse.json({ ok: true, username });
  response.cookies.set({
    ...getSessionCookieOptions(),
    value: token,
  });
  return response;
}
