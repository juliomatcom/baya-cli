import Link from 'next/link';

export default function NotFound() {
  return (
    <main className="surface-dark flex flex-1 items-center justify-center px-6 py-24">
      <div className="max-w-xl text-center">
        <p className="font-mono text-sm font-semibold uppercase tracking-[0.25em] text-accent">
          404
        </p>
        <h1 className="mt-5 text-4xl text-white sm:text-5xl">Page not found</h1>
        <p className="mt-6 text-lg text-slate-400">
          The page you are looking for does not exist or may have moved.
        </p>
        <Link href="/" className="btn-accent mt-8">
          Back to home
        </Link>
      </div>
    </main>
  );
}
