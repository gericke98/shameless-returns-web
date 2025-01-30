"use server";

import db from "@/db/drizzle";
import crypto from "crypto";
import { cookies } from "next/headers";

export async function login(formData: FormData) {
  const username = formData.get("username");
  const password = formData.get("password");

  if (!username || !password) {
    return { error: "Username and password are required" };
  }

  try {
    // Find user by username
    const user = await db.query.users.findFirst({
      where: (users, { eq }) => eq(users.username, username.toString()),
    });

    if (!user) {
      return { error: "Invalid credentials" };
    }

    // Split stored hash and salt
    const [storedSalt, storedHash] = user.hashedPassword.split(":");

    // Hash the provided password with the stored salt
    const hashedPassword = crypto
      .pbkdf2Sync(password.toString(), storedSalt, 1000, 64, "sha256")
      .toString("hex");

    // Compare the hashes
    if (hashedPassword === storedHash) {
      // Set a session cookie
      const sessionToken = crypto.randomBytes(32).toString("hex");
      cookies().set("session", sessionToken, {
        httpOnly: true,
        secure: process.env.NODE_ENV === "production",
        sameSite: "lax",
        maxAge: 60 * 60 * 24 * 7, // 1 week
      });

      return { success: true, user: { username: user.username } };
    } else {
      return { error: "Invalid credentials" };
    }
  } catch (error) {
    console.error("Login error:", error);
    return { error: "An error occurred during login" };
  }
}

export async function checkAuth() {
  const sessionCookie = cookies().get("session");
  if (!sessionCookie?.value) {
    return null;
  }

  // For now, returning mock user data - you should fetch this from your database
  return {
    user: {
      username: "admin",
      email: "hello@shamelesscollective.com",
    },
  };
}
