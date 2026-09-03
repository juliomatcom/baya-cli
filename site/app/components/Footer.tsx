import Link from 'next/link';

const FOOTER_LINKS = [
  { label: 'Features', href: '/features' },
  { label: 'Docs', href: '/docs' },
  { label: 'FAQ', href: '/faq' },
  { label: 'GitHub', href: 'https://github.com/juliomatcom/baya-cli' },
];

export default function Footer() {
  return (
    <footer className="mt-auto border-t border-slate-200 bg-slate-50">
      <div className="mx-auto flex max-w-6xl flex-col gap-4 px-6 py-6 text-sm sm:flex-row sm:items-center sm:justify-between">
        <p className="text-slate-600">
          © 2026 Julio Cesar Martin · Released under the{' '}
          <a
            href="https://github.com/juliomatcom/baya-cli/blob/main/LICENSE"
            target="_blank"
            rel="noreferrer noopener"
          >
            MIT License
          </a>
        </p>
        <nav aria-label="Footer">
          <ul className="flex flex-wrap gap-x-6 gap-y-2">
            {FOOTER_LINKS.map((link) => (
              <li key={link.href}>
                {link.href.startsWith('http') ? (
                  <a href={link.href} target="_blank" rel="noreferrer noopener">
                    {link.label}
                  </a>
                ) : (
                  <Link href={link.href}>{link.label}</Link>
                )}
              </li>
            ))}
          </ul>
        </nav>
      </div>
    </footer>
  );
}
