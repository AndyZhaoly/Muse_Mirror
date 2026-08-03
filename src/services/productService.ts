import fs from 'node:fs';
import path from 'node:path';
import type { ProductItem } from '../types.js';

export interface ProductSearchInput {
  query: string;
  category?: string;
  color?: string;
  maxPrice?: number;
  limit?: number;
}

export class ProductService {
  private readonly products: ProductItem[];

  constructor(dataPath = path.resolve('./data/mock-products.json')) {
    this.products = JSON.parse(
      fs.readFileSync(dataPath, 'utf8'),
    ) as ProductItem[];
  }

  async search(input: ProductSearchInput): Promise<ProductItem[]> {
    const tokens = input.query.toLowerCase().split(/\s+/).filter(Boolean);
    return this.products
      .filter((product) => {
        if (input.category && product.category !== input.category) return false;
        if (input.color && product.color !== input.color) return false;
        if (input.maxPrice !== undefined && product.price > input.maxPrice) {
          return false;
        }
        return true;
      })
      .map((product) => {
        const haystack = [
          product.title,
          product.brand,
          product.color,
          product.category,
        ]
          .join(' ')
          .toLowerCase();
        return {
          product,
          score: tokens.reduce(
            (sum, token) => sum + (haystack.includes(token) ? 1 : 0),
            0,
          ),
        };
      })
      .sort((a, b) => b.score - a.score || a.product.price - b.product.price)
      .slice(0, input.limit ?? 6)
      .map(({ product }) => product);
  }
}
