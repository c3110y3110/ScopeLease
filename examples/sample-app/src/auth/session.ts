export type UserSession = {
  id: string;
  role: "admin" | "member";
  token: string;
};

export function validateToken(token: string): UserSession | null {
  if (!token || token.length < 12) {
    return null;
  }

  return {
    id: "user_123",
    role: token.includes("admin") ? "admin" : "member",
    token
  };
}

export function canElevateRole(session: UserSession): boolean {
  return session.role === "admin";
}
