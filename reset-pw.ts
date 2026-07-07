import { hash } from "@node-rs/argon2";
import { prisma } from "./src/server/db";

async function main() {
  const email = (process.env.CATWORLD_ADMIN_EMAIL ?? "admin@example.com").toLowerCase();
  const password = process.env.CATWORLD_ADMIN_PASSWORD;
  if (!password) throw new Error("CATWORLD_ADMIN_PASSWORD not set");
  const passwordHash = await hash(password);
  const result = await prisma.user.upsert({
    where: { email },
    update: { passwordHash, active: true, role: "ADMIN" },
    create: { name: process.env.CATWORLD_ADMIN_NAME ?? "Administrador", email, passwordHash, role: "ADMIN" },
  });
  console.log("Password reset for", result.email);
  await prisma.$disconnect();
}

void main().catch(e => { console.error(e); process.exitCode = 1; });
