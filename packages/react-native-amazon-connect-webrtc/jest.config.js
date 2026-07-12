/** Tests exercise the pure TypeScript core (backend client + controller) with injected fakes —
 *  no react-native runtime is needed; the mock below satisfies the module imports. */
module.exports = {
  preset: 'ts-jest',
  testEnvironment: 'node',
  roots: ['<rootDir>/__tests__'],
  testMatch: ['**/*.test.ts'],
  moduleNameMapper: {
    '^react-native$': '<rootDir>/__tests__/helpers/react-native-mock.ts',
  },
};
