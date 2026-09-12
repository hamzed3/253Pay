// Tests d'intégration : ils ont besoin d'un vrai PostgreSQL.
//
// Séparés des tests unitaires (jest.config.js) exprès : `npm test` doit
// rester lançable sans Docker, en quelques secondes. Ici on vérifie ce
// qu'aucun test unitaire ne peut vérifier — que la BASE elle-même refuse
// les opérations interdites.
//
//   npm run test:integration
module.exports = {
  displayName: '253Pay Intégration',
  moduleFileExtensions: ['js', 'json', 'ts'],
  rootDir: '.',
  testMatch: ['<rootDir>/test/**/*.integration-spec.ts'],
  transform: {
    '^.+\\.(t|j)s$': 'ts-jest',
  },
  testEnvironment: 'node',
  globalSetup: '<rootDir>/test/global-setup.ts',
  // Une seule base jetable, donc pas de tests en parallèle.
  maxWorkers: 1,
  testTimeout: 30000,
  moduleNameMapper: {
    '^@/(.*)$': '<rootDir>/src/$1',
  },
};
