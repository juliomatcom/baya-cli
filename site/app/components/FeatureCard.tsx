import FeatureIcon, { type FeatureIconName } from '@/app/components/FeatureIcon';

export type FeatureCardProps = {
  icon: FeatureIconName;
  title: string;
  description: string;
  /** Optional ordinal shown before the title, e.g. `01`. */
  number?: string;
};

/**
 * The site's shared dark rounded card: green icon badge, bold title (optionally
 * numbered), muted description. Used by the home teaser and the features grid.
 */
export default function FeatureCard({
  icon,
  title,
  description,
  number,
}: FeatureCardProps) {
  return (
    <div className="card-dark h-full p-6 text-slate-300">
      <span className="icon-badge">
        <FeatureIcon name={icon} />
      </span>
      <h3 className="mt-4 text-base font-bold text-white">
        {number ? <span className="text-accent">{number}&nbsp;</span> : null}
        {title}
      </h3>
      <p className="mt-2 text-sm leading-relaxed text-slate-400">{description}</p>
    </div>
  );
}
