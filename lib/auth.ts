import { NextAuthOptions } from "next-auth";
import CredentialsProvider from "next-auth/providers/credentials";
import { compare } from "bcryptjs";
import db from "@/db/drizzle";
import { getBaseUrl } from "./config";

export const authOptions: NextAuthOptions = {
  session: {
    strategy: "jwt",
    maxAge: 30 * 24 * 60 * 60, // 30 days
  },
  providers: [
    CredentialsProvider({
      name: "Credentials",
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      async authorize(credentials) {
        if (!credentials?.email || !credentials?.password) {
          throw new Error("Missing credentials");
        }

        const user = await db.query.users.findFirst({
          where: (users, { eq }) => eq(users.username, credentials.email),
        });

        if (!user) {
          throw new Error("Invalid credentials");
        }

        const isValid = await compare(
          credentials.password,
          user.hashedPassword
        );

        if (!isValid) {
          throw new Error("Invalid credentials");
        }

        return {
          id: user.id,
          email: user.username,
          username: user.username,
          role: "admin",
        };
      },
    }),
  ],
  callbacks: {
    async jwt({ token, user }) {
      if (user) {
        token.role = user.role;
      }
      return token;
    },
    async session({ session, token }) {
      if (session.user) {
        session.user.role = token.role as string;
      }
      return session;
    },
  },
  pages: {
    signIn: "/login",
  },
  secret: process.env.NEXTAUTH_SECRET,
};
