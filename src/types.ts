export type Chain = "k-ruoka" | "s-kaupat";

export interface Product {
	name: string;
	price: number | null;
	unitPrice: string | null;
	ean: string;
	imageUrl: string | null;
	brand: string | null;
	category: string | null;
}

export interface Store {
	id: string;
	name: string;
	chain: Chain;
	location: string;
}

export interface SearchResult {
	products: Product[];
	totalCount: number;
	query: string;
	storeId: string;
	chain: Chain;
}
