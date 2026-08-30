/**
 * The design tokens are a closed set, but two things walk straight past it:
 * a Tailwind arbitrary value (`p-[13px]`, `bg-[#fff]`) and an inline `style`.
 * Both put a number in a component that no stylesheet knows about, which is how
 * a token system becomes a suggestion.
 *
 * A value that genuinely has to be computed — the width of a usage bar — is
 * still allowed, with a disable comment that says why, the same way this
 * repository treats `as`.
 *
 * `__tests__/no-off-token-styles.spec.ts` drives this with every shape a class
 * list is written in, because a guard nobody has seen fail might not work.
 */

const ARBITRARY = /\[[^\]]*\]/;

/** Stands in for an interpolation when a template literal is rejoined. Cannot
 * appear in a class name, and reads as what it is in the reported message. */
const GAP = '…';

/**
 * Class lists as `{ node, text }`, where a template literal is rejoined first:
 * `` `p-[${n}px]` `` arrives as the two pieces `p-[` and `px]`, and neither one
 * looks like an arbitrary value on its own.
 */
function classStrings(node) {
  if (node.type === 'Literal' && typeof node.value === 'string') {
    return [{ node, text: node.value }];
  }
  if (node.type === 'TemplateLiteral') {
    return [{ node, text: node.quasis.map((quasi) => quasi.value.raw).join(GAP) }];
  }
  // A `cx(...)` call is left to the CallExpression visitor, so a class inside
  // one is not reported twice.
  if (node.type === 'JSXExpressionContainer' && node.expression.type !== 'CallExpression') {
    return classStrings(node.expression);
  }
  if (node.type === 'ConditionalExpression') {
    return [...classStrings(node.consequent), ...classStrings(node.alternate)];
  }
  // `cond && 'class'` is the commoner idiom of the two; anything on either side
  // that is not a string falls out of the walk on its own.
  if (node.type === 'LogicalExpression') {
    return [...classStrings(node.left), ...classStrings(node.right)];
  }
  return [];
}

/** @type {import('eslint').Rule.RuleModule} */
const rule = {
  meta: {
    type: 'problem',
    docs: { description: 'Keep every visual value inside the design tokens.' },
    schema: [],
    messages: {
      arbitrary:
        'Arbitrary value "{{value}}" bypasses the tokens. Use a step from the scale, or add one to tokens.css so the decision is visible in the diff.',
      inlineStyle:
        'Inline `style` puts a value outside the stylesheet. Use a token class; if the value is genuinely computed, disable this rule on the line and say why.',
    },
  },
  create(context) {
    const report = (node) => {
      for (const part of classStrings(node)) {
        const match = ARBITRARY.exec(part.text);
        if (match !== null) {
          context.report({ node: part.node, messageId: 'arbitrary', data: { value: match[0] } });
        }
      }
    };

    return {
      JSXAttribute(node) {
        if (node.name.name === 'style') {
          context.report({ node, messageId: 'inlineStyle' });
          return;
        }
        if (node.name.name === 'className' && node.value !== null) report(node.value);
      },
      CallExpression(node) {
        if (node.callee.type !== 'Identifier' || node.callee.name !== 'cx') return;
        for (const argument of node.arguments) report(argument);
      },
    };
  },
};

export default {
  meta: { name: 'local-tokens' },
  rules: { 'no-off-token-styles': rule },
};
