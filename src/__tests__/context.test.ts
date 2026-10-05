import { describe, it, expect } from 'vitest';
import { findDuplicate } from '../core/context.js';

/**
 * These guard the fix for the planner proposing work that already existed
 * ("add a sleep utility" when `sleep` was already exported).
 */
describe('findDuplicate', () => {
  const known = [
    'Add retry status fields to task schema',
    'Implement listFiles in git.ts',
    'Create data/reports directory',
  ];

  it('catches an exact restatement', () => {
    expect(findDuplicate('Add retry status fields to task schema', known)).not.toBeNull();
  });

  it('catches a reworded restatement', () => {
    expect(findDuplicate('Implement the listFiles helper in git.ts', known)).not.toBeNull();
  });

  it('ignores filler words when comparing', () => {
    // "add"/"create"/"helper" are stopwords, so these are the same proposal.
    expect(findDuplicate('Create listFiles in git.ts', known)).not.toBeNull();
  });

  it('lets genuinely new work through', () => {
    expect(findDuplicate('Write a CSV exporter for the ledger', known)).toBeNull();
    expect(findDuplicate('Add weekly rollup report', known)).toBeNull();
  });

  it('does not match on stopwords alone', () => {
    // Nothing but filler in common — must not be treated as a duplicate.
    expect(findDuplicate('Add a helper', ['Create the utility'])).toBeNull();
  });

  it('returns the title it collided with, for the log message', () => {
    expect(findDuplicate('Implement listFiles in git.ts', known)).toBe('Implement listFiles in git.ts');
  });
});
