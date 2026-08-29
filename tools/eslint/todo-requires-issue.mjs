/**
 * A TODO without a tracking issue is a note to nobody: it never surfaces in
 * planning and never expires. Only `// TODO(#123): ...` is accepted.
 */

const WELL_FORMED = /^\s*(?:TODO|FIXME)\(#\d+\):\s+\S/;
const ANY_MARKER = /(^|[^\w])(TODO|FIXME)\b/i;

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'suggestion',
    docs: { description: 'Require TODO and FIXME comments to reference an issue number.' },
    schema: [],
    messages: {
      missingIssue:
        'Write "{{marker}}(#123): what needs doing" — a {{marker}} without an issue reference cannot be tracked.',
    },
  },
  create(context) {
    return {
      Program() {
        for (const comment of context.sourceCode.getAllComments()) {
          const match = ANY_MARKER.exec(comment.value);
          if (match === null) continue;

          // Only a marker opening the comment is a work item; "the TODO rule" is not.
          const text = comment.value.replace(/^\s*\*+/, '').trimStart();
          if (!/^(TODO|FIXME)\b/i.test(text)) continue;
          if (WELL_FORMED.test(text)) continue;

          context.report({
            node: comment,
            messageId: 'missingIssue',
            data: { marker: (match[2] ?? 'TODO').toUpperCase() },
          });
        }
      },
    };
  },
};

export default {
  meta: { name: 'local' },
  rules: { 'todo-requires-issue': rule },
};
