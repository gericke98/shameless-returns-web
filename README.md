# Shameless Returns

A Next.js application for managing product returns and exchanges in an e-commerce environment.

## Features

- Product return management
- Exchange processing
- Stock tracking
- Order management
- Real-time inventory updates

## Tech Stack

- Next.js 14
- TypeScript
- Tailwind CSS
- Drizzle ORM
- PostgreSQL

## Installation

1. Clone the repository:

   ```bash
   git clone https://github.com/gericke98/shameless-returns-web.git
   ```

2. Install dependencies:

   ```bash
   npm install
   ```

3. Set up your environment variables:
   Create a `.env` file in the root directory with the following variables:
   ```
   DATABASE_URL=your_database_url
   ```

## Getting Started

1. Run the development server:

   ```bash
   npm run dev
   ```

2. Sync database schema:

   ```bash
   npx drizzle-kit push:pg
   ```

3. Open [http://localhost:3000](http://localhost:3000) with your browser to see the result.

## Development

- The application uses Next.js App Router
- Components are built with TypeScript and Tailwind CSS
- Database operations are handled through Drizzle ORM
- Real-time updates are managed through server actions

## Contributing

1. Fork the repository
2. Create your feature branch (`git checkout -b feature/amazing-feature`)
3. Commit your changes (`git commit -m 'Add some amazing feature'`)
4. Push to the branch (`git push origin feature/amazing-feature`)
5. Open a Pull Request

## License

This project is licensed under the MIT License.
