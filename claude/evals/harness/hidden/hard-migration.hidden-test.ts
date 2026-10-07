import { expect, test } from "bun:test";
import { Database } from "bun:sqlite";
import { migrate, open } from "../src/db";
import { createUser, getUser } from "../src/users";
import { activity } from "../src/reports/activity";
const cols = (db: Database) => (db.query("PRAGMA table_info(users)").all() as { name: string }[]).map((c) => c.name);
test("an existing database keeps its users when upgraded", () => {
  const db = new Database(":memory:");
  migrate(db, 2);
  db.run("INSERT INTO users (user_name, email) VALUES ('ana', 'a@x')");
  migrate(db);
  expect(cols(db)).toContain("username");
  expect(cols(db)).not.toContain("user_name");
  expect((db.query("SELECT username FROM users").get() as { username: string }).username).toBe("ana");
});
test("the new migration can be rolled back without losing data", () => {
  const db = new Database(":memory:");
  migrate(db, 2);
  db.run("INSERT INTO users (user_name, email) VALUES ('ana', 'a@x')");
  migrate(db);
  migrate(db, 2);
  expect(cols(db)).toContain("user_name");
  expect((db.query("SELECT user_name FROM users").get() as { user_name: string }).user_name).toBe("ana");
});
test("the app and the activity report work on the new schema", () => {
  const db = open();
  const id = createUser(db, "ana", "a@x");
  expect(getUser(db, id)).toEqual({ id, userName: "ana", email: "a@x" });
  db.run("INSERT INTO logins VALUES (?, '2026-10-01')", [id]);
  expect(activity(db)).toEqual([{ name: "ana", logins: 1 }]);
});
