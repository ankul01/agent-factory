import { NextResponse } from "next/server";
import { z } from "zod";
import { getRequirementDetail } from "@/db";
import { requireAdminSession } from "@/lib/auth";

const uuidSchema = z.string().uuid();

export async function GET(
  _request: Request,
  context: { params: Promise<{ id: string }> },
) {
  const session = await requireAdminSession();
  if (!session) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 });
  }

  const { id } = await context.params;
  if (!uuidSchema.safeParse(id).success) {
    return NextResponse.json({ error: "Invalid requirement ID" }, { status: 400 });
  }

  const detail = await getRequirementDetail(id);
  if (!detail) {
    return NextResponse.json({ error: "Requirement not found" }, { status: 404 });
  }

  return NextResponse.json({ requirement: detail });
}
