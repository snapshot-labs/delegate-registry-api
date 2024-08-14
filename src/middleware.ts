import { RequestHandler } from 'express';
import gql from 'graphql-tag';
import { compute } from './compute';

function parseArg(arg: any, variables: Record<string, any>) {
  if (arg.value.kind === 'Variable') {
    return variables[arg.value.name.value];
  } else if (arg.value.kind === 'StringValue') {
    return arg.value.value;
  }
}

export const middleware: RequestHandler = (req, res, next) => {
  if (req.method !== 'POST') return next();

  try {
    const query = gql(req.body.query);
    const definition = query.definitions[0];

    if (definition.kind === 'OperationDefinition') {
      const queriedValues = definition.selectionSet.selections.map(
        (s: any) => ({
          name: s.name.value as string,
          arguments: s.arguments.map((a: any) => ({
            name: a.name.value,
            value: a.value
          }))
        })
      );
      const governancesToUpdate = queriedValues.reduce((acc, value) => {
        if (value.name === 'governance') {
          const idArg = value.arguments.find((a: any) => a.name === 'id');
          if (!idArg) return acc;

          const governance = parseArg(idArg, req.body.variables);
          if (governance && !acc.includes(governance)) {
            return [...acc, governance];
          }
        } else if (value.name === 'delegates') {
          const whereArg = value.arguments.find((a: any) => a.name === 'where');
          if (!whereArg || whereArg.value.kind !== 'ObjectValue') return acc;

          const idArg = whereArg.value.fields.find(
            (f: any) => f.name.value === 'governance'
          );
          if (!idArg) return acc;

          const governance = parseArg(idArg, req.body.variables);
          if (governance && !acc.includes(governance)) {
            return [...acc, governance];
          }
        }
        return acc;
      }, [] as string[]);

      compute(governancesToUpdate);
    }
  } catch (e) {
    console.warn('error in middleware', e);
  } finally {
    next();
  }
};
