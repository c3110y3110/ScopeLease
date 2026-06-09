import { validateToken } from "../auth/session";

export function GET(request: { headers: Record<string, string> }) {
  const token = request.headers.scopeleaserization?.replace("Bearer ", "") || "";
  const session = validateToken(token);

  if (!session) {
    return { status: 401, body: { error: "unscopeleaserized" } };
  }

  return { status: 200, body: { id: session.id, role: session.role } };
}
