import type { ComponentType } from 'react';
import CliReference from './CliReference';
import Configuration from './Configuration';
import Consensus from './Consensus';
import Contributing from './Contributing';
import DesignPrinciples from './DesignPrinciples';
import HowItWorks from './HowItWorks';
import Install from './Install';
import ModelRouting from './ModelRouting';
import Overview from './Overview';
import Providers from './Providers';
import QuickStart from './QuickStart';
import Recovery from './Recovery';
import Run from './Run';
import TaskLists from './TaskLists';

export type DocSection = {
  /** Anchor id; must match the `id` on the section's own <h2>. */
  id: string;
  /** Label shown in the "On this page" rail. */
  label: string;
  Component: ComponentType;
};

/** Render order for both the nav rail and the page body. */
export const DOC_SECTIONS: DocSection[] = [
  { id: 'overview', label: 'Overview', Component: Overview },
  { id: 'install', label: 'Install & first run', Component: Install },
  { id: 'quickstart', label: 'Quick start', Component: QuickStart },
  { id: 'task-lists', label: 'Writing task lists', Component: TaskLists },
  { id: 'models', label: 'Model routing', Component: ModelRouting },
  { id: 'run', label: 'Run', Component: Run },
  { id: 'consensus', label: 'AI Consensus', Component: Consensus },
  { id: 'internals', label: 'Design principles', Component: DesignPrinciples },
  { id: 'cli', label: 'CLI reference', Component: CliReference },
  { id: 'providers', label: 'Providers', Component: Providers },
  { id: 'config', label: 'Configuration', Component: Configuration },
  { id: 'recovery', label: 'Recovery & resume', Component: Recovery },
  { id: 'how-it-works', label: 'How it works', Component: HowItWorks },
  { id: 'contributing', label: 'Contributing', Component: Contributing },
];
