import type { Metadata } from 'next';
import FeaturesTeaser from '@/app/components/FeaturesTeaser';
import Hero from '@/app/components/Hero';
import {
  GITHUB_URL,
  pageMetadata,
  SITE_DESCRIPTION,
  SITE_URL,
} from '@/app/lib/site';

export const metadata: Metadata = pageMetadata({
  title: 'Baya – Local AI multi-provider CLI orchestrator.',
  description:
    'Run plain-text coding tasks across the AI agents you already use. Baya builds a dependency graph, routes each task to the fitting provider and model, and carries the run through to a report.',
  path: '/',
});

const softwareJsonLd = {
  '@context': 'https://schema.org',
  '@type': 'SoftwareApplication',
  name: 'Baya',
  description: SITE_DESCRIPTION,
  applicationCategory: 'DeveloperApplication',
  operatingSystem: 'macOS, Linux, Windows',
  url: SITE_URL,
  downloadUrl: 'https://www.npmjs.com/package/baya-cli',
  softwareVersion: 'early',
  license: 'https://opensource.org/licenses/MIT',
  isAccessibleForFree: true,
  offers: {
    '@type': 'Offer',
    price: 0,
    priceCurrency: 'USD',
  },
  author: {
    '@type': 'Person',
    name: 'Julio Cesar Martin',
  },
  codeRepository: GITHUB_URL,
};

export default function HomePage() {
  return (
    <main>
      <script
        type="application/ld+json"
        dangerouslySetInnerHTML={{
          __html: JSON.stringify(softwareJsonLd).replace(/</g, '\\u003c'),
        }}
      />
      <Hero />
      <FeaturesTeaser />
    </main>
  );
}
