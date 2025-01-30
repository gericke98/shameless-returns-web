import "dotenv/config";
import db from "../db/drizzle";
import { users } from "../db/schema";
import { hash } from "bcrypt";
import { v4 as uuidv4 } from "uuid";

async function createAdmin() {
  const adminUsername = process.env.ADMIN_USERNAME;
  const adminPassword = process.env.ADMIN_PASSWORD;

  if (!adminUsername || !adminPassword) {
    console.error("Please set ADMIN_USERNAME and ADMIN_PASSWORD in .env");
    process.exit(1);
  }

  const hashedPassword = await hash(adminPassword, 10);

  try {
    await db.insert(users).values({
      id: uuidv4(),
      username: adminUsername,
      hashedPassword,
    });
    console.log("Admin user created successfully!");
  } catch (error) {
    console.error("Error creating admin user:", error);
  }

  process.exit(0);
}

createAdmin();
