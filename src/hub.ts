import { ApolloClient, gql, InMemoryCache } from '@apollo/client/core';
import { HUB_URL } from './constants';

export const SPACE_QUERY = gql`
  query Space($id: String!) {
    space(id: $id) {
      id
      network
      strategies {
        name
        network
        params
      }
    }
  }
`;

export type Space = {
  id: string;
  network: string;
  strategies: {
    name: string;
    network: string;
    params: any;
  }[];
};

const client = new ApolloClient({
  uri: `${HUB_URL}/graphql`,
  cache: new InMemoryCache()
});

export async function getSpace(space: string): Promise<Space> {
  const { data } = await client.query({
    query: SPACE_QUERY,
    variables: { id: space }
  });

  return data.space;
}
