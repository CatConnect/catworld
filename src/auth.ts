import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import { verify } from "@node-rs/argon2";
import { z } from "zod";
import { prisma } from "@/server/db";

const credentialsSchema = z.object({ email: z.string().email(), password: z.string().min(8).max(128) });

export const { handlers, auth, signIn, signOut } = NextAuth({
  trustHost: true,
  session: { strategy: "jwt", maxAge: 8 * 60 * 60 },
  pages: { signIn: "/login" },
  providers: [Credentials({
    credentials: { email: { type: "email" }, password: { type: "password" } },
    async authorize(raw) {
      const parsed = credentialsSchema.safeParse(raw);
      if (!parsed.success) return null;
      const user = await prisma.user.findUnique({ where: { email: parsed.data.email.toLowerCase() } });
      if (!user?.active || !(await verify(user.passwordHash, parsed.data.password))) return null;
      return { id: user.id, name: user.name, email: user.email, role: user.role };
    },
  })],
  callbacks: {
    jwt({ token, user }) { if (user) { token.sub = user.id; token.role = (user as { role: string }).role; } return token; },
    session({ session, token }) { if (session.user) { session.user.id = token.sub!; session.user.role = String(token.role ?? "VIEWER"); } return session; },
  },
});