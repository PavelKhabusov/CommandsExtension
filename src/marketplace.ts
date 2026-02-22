import { CommandDefinition } from './types';

export interface TemplateGroup {
  id: string;
  name: string;
  description: string;
  icon: string;
  commands: CommandDefinition[];
}

const marketplaceTemplates: TemplateGroup[] = [
  {
    id: 'react',
    name: 'React',
    description: 'Common React project commands',
    icon: '\u269B',
    commands: [
      { name: 'Dev Server', command: 'npm run dev', type: 'terminal', group: 'React' },
      { name: 'Build', command: 'npm run build', type: 'terminal', group: 'React' },
      { name: 'Test', command: 'npm test', type: 'terminal', group: 'React' },
      { name: 'Lint', command: 'npm run lint', type: 'terminal', group: 'React' },
      { name: 'Format', command: 'npm run format', type: 'terminal', group: 'React' },
    ],
  },
  {
    id: 'node-backend',
    name: 'Node.js Backend',
    description: 'Node.js server development commands',
    icon: '\u2B22',
    commands: [
      { name: 'Start', command: 'npm start', type: 'terminal', group: 'Backend' },
      { name: 'Dev', command: 'npm run dev', type: 'terminal', group: 'Backend' },
      { name: 'Build', command: 'npm run build', type: 'terminal', group: 'Backend' },
      { name: 'Test', command: 'npm test', type: 'terminal', group: 'Backend' },
      { name: 'DB Migrate', command: 'npm run db:migrate', type: 'terminal', group: 'Backend' },
    ],
  },
  {
    id: 'docker',
    name: 'Docker',
    description: 'Docker container management',
    icon: '\uD83D\uDC33',
    commands: [
      { name: 'Docker Build', command: 'docker build -t app .', type: 'terminal', group: 'Docker' },
      { name: 'Docker Up', command: 'docker compose up -d', type: 'terminal', group: 'Docker' },
      { name: 'Docker Down', command: 'docker compose down', type: 'terminal', group: 'Docker' },
      { name: 'Docker Logs', command: 'docker compose logs -f', type: 'terminal', group: 'Docker' },
    ],
  },
  {
    id: 'testing',
    name: 'Testing',
    description: 'Test runner commands',
    icon: '\u2713',
    commands: [
      { name: 'Test', command: 'npm test', type: 'terminal', group: 'Testing' },
      { name: 'Test Watch', command: 'npm run test:watch', type: 'terminal', group: 'Testing' },
      { name: 'Test Coverage', command: 'npm run test:coverage', type: 'terminal', group: 'Testing' },
    ],
  },
  {
    id: 'linting',
    name: 'Linting & Formatting',
    description: 'Code quality commands',
    icon: '\u2728',
    commands: [
      { name: 'Lint', command: 'npm run lint', type: 'terminal', group: 'Linting' },
      { name: 'Lint Fix', command: 'npm run lint:fix', type: 'terminal', group: 'Linting' },
      { name: 'Format', command: 'npm run format', type: 'terminal', group: 'Linting' },
      { name: 'Typecheck', command: 'npm run typecheck', type: 'terminal', group: 'Linting' },
    ],
  },
  {
    id: 'git-hooks',
    name: 'Git Hooks',
    description: 'Git hook setup commands',
    icon: '\uD83E\uDE9D',
    commands: [
      { name: 'Prepare', command: 'npm run prepare', type: 'terminal', group: 'Git Hooks' },
      { name: 'Pre-commit', command: 'npm run pre-commit', type: 'terminal', group: 'Git Hooks' },
      { name: 'Pre-push', command: 'npm run pre-push', type: 'terminal', group: 'Git Hooks' },
    ],
  },
  {
    id: 'git',
    name: 'Git',
    description: 'Common git workflow commands',
    icon: '\uD83D\uDD00',
    commands: [
      { name: 'Status', command: 'git status', type: 'terminal', group: 'Git' },
      { name: 'Pull', command: 'git pull', type: 'terminal', group: 'Git' },
      { name: 'Push', command: 'git push', type: 'terminal', group: 'Git' },
      { name: 'Push (set upstream)', command: 'git push -u origin HEAD', type: 'terminal', group: 'Git' },
      { name: 'Commit all', command: 'git add -A && git commit', type: 'terminal', group: 'Git' },
      { name: 'Log (oneline)', command: 'git log --oneline -20', type: 'terminal', group: 'Git' },
      { name: 'Stash', command: 'git stash', type: 'terminal', group: 'Git' },
      { name: 'Stash Pop', command: 'git stash pop', type: 'terminal', group: 'Git' },
    ],
  },
  {
    id: 'expo',
    name: 'Expo',
    description: 'Expo / React Native commands',
    icon: '\uD83D\uDCF1',
    commands: [
      { name: 'Start', command: 'npx expo start', type: 'terminal', group: 'Expo' },
      { name: 'Start (clear cache)', command: 'npx expo start -c', type: 'terminal', group: 'Expo' },
      { name: 'iOS', command: 'npx expo run:ios', type: 'terminal', group: 'Expo' },
      { name: 'Android', command: 'npx expo run:android', type: 'terminal', group: 'Expo' },
      { name: 'Export', command: 'npx expo export', type: 'terminal', group: 'Expo' },
      { name: 'Install', command: 'npx expo install', type: 'terminal', group: 'Expo' },
      { name: 'Prebuild', command: 'npx expo prebuild', type: 'terminal', group: 'Expo' },
      { name: 'EAS Build (dev)', command: 'eas build --profile development', type: 'terminal', group: 'Expo' },
      { name: 'EAS Build (preview)', command: 'eas build --profile preview', type: 'terminal', group: 'Expo' },
      { name: 'EAS Submit', command: 'eas submit', type: 'terminal', group: 'Expo' },
    ],
  },
  {
    id: 'nextjs',
    name: 'Next.js',
    description: 'Next.js development commands',
    icon: '\u25B2',
    commands: [
      { name: 'Dev', command: 'npm run dev', type: 'terminal', group: 'Next.js' },
      { name: 'Build', command: 'npm run build', type: 'terminal', group: 'Next.js' },
      { name: 'Start', command: 'npm start', type: 'terminal', group: 'Next.js' },
      { name: 'Lint', command: 'npm run lint', type: 'terminal', group: 'Next.js' },
    ],
  },
  {
    id: 'python',
    name: 'Python',
    description: 'Python project commands',
    icon: '\uD83D\uDC0D',
    commands: [
      { name: 'Run', command: 'python main.py', type: 'terminal', group: 'Python' },
      { name: 'Install deps', command: 'pip install -r requirements.txt', type: 'terminal', group: 'Python' },
      { name: 'Pytest', command: 'pytest', type: 'terminal', group: 'Python' },
      { name: 'Pytest (verbose)', command: 'pytest -v', type: 'terminal', group: 'Python' },
      { name: 'Freeze deps', command: 'pip freeze > requirements.txt', type: 'terminal', group: 'Python' },
    ],
  },
  {
    id: 'turborepo',
    name: 'Turborepo',
    description: 'Monorepo with Turborepo',
    icon: '\uD83D\uDE80',
    commands: [
      { name: 'Build', command: 'npx turbo build', type: 'terminal', group: 'Turborepo' },
      { name: 'Dev', command: 'npx turbo dev', type: 'terminal', group: 'Turborepo' },
      { name: 'Lint', command: 'npx turbo lint', type: 'terminal', group: 'Turborepo' },
      { name: 'Test', command: 'npx turbo test', type: 'terminal', group: 'Turborepo' },
    ],
  },
  {
    id: 'deploy',
    name: 'Deploy',
    description: 'Common deployment commands',
    icon: '\u2601',
    commands: [
      { name: 'Vercel Deploy', command: 'vercel', type: 'terminal', group: 'Deploy' },
      { name: 'Vercel (prod)', command: 'vercel --prod', type: 'terminal', group: 'Deploy' },
      { name: 'Netlify Deploy', command: 'netlify deploy', type: 'terminal', group: 'Deploy' },
      { name: 'Netlify (prod)', command: 'netlify deploy --prod', type: 'terminal', group: 'Deploy' },
    ],
  },
];

export function getMarketplaceTemplates(): TemplateGroup[] {
  return marketplaceTemplates;
}
