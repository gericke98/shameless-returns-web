import { config } from "dotenv";
import { hash } from "bcryptjs";
import { neon } from "@neondatabase/serverless";
import { drizzle } from "drizzle-orm/neon-http";
import { users } from "@/db/schema";

// Load environment variables
config();

// Connect to database
const sql = neon(process.env.DATABASE_URL!);
const db = drizzle(sql);

async function createAdminUser() {
  const username = "hello@shamelesscollective.com";
  const password = "Shameless1998-";

  const hashedPassword = await hash(password, 12);

  try {
    await db.insert(users).values({
      id: "admin",
      username,
      hashedPassword,
    });
    console.log("Admin user created successfully");
  } catch (error) {
    console.error("Error creating admin user:", error);
  }
}

createAdminUser();
