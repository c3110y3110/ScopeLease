import { validateToken } from "../../src/auth/session";

export function testRejectsShortToken() {
  if (validateToken("short") !== null) {
    throw new Error("expected short token to be rejected");
  }
}
