import 'package:flutter/material.dart';
import 'package:flutter_riverpod/flutter_riverpod.dart';

// --- Mock Data Structures (Replace with actual models) ---
// Represents a single product displayed within a menu
class Product {
  final String id;
  final String name;
  final String? description;
  final String? imageUrl;
  final String formattedPrice; // e.g., "₪15.00"
  final List<String>? tags; // e.g., ["New", "Vegan", "Discount_10"]
  final int priority; // For sorting within category/menu

  Product({
    required this.id,
    required this.name,
    this.description,
    this.imageUrl,
    required this.formattedPrice,
    this.tags,
    required this.priority,
  });
}

// Represents a menu section (e.g., "Drinks", "Snacks") or a full menu
class MenuSection {
  final String id;
  final String name; // e.g., "Cold Drinks" or "Main Menu"
  final int priority; // For sorting sections/menus
  final List<Product> products;

  MenuSection({
    required this.id,
    required this.name,
    required this.priority,
    required this.products,
  });
}

// Represents the overall data for the screen
class BoxMenuData {
  final String boxId;
  final String boxNumber; // V5: Prominent Box Number
  final String? boxName; // Optional descriptive name
  final String currencySymbol; // e.g., "₪"
  final List<MenuSection> menuSections; // List of menus/sections to display

  BoxMenuData({
    required this.boxId,
    required this.boxNumber,
    this.boxName,
    required this.currencySymbol,
    required this.menuSections,
  });
}

// --- Mock Data Provider (Replace with actual Riverpod provider fetching data) ---
final boxMenuDataProvider = FutureProvider.autoDispose.family<BoxMenuData, String>((ref, boxId) async {
  // Simulate network delay
  await Future.delayed(const Duration(seconds: 1));

  // --- V5 Mock Data ---
  // Return mock data based on V5 design (priority-based menus, no map)
  // Assume menus are fetched based on boxId and sorted by priority server-side
  // Here we simulate that structure.
  return BoxMenuData(
    boxId: boxId,
    boxNumber: "UC-101", // Example Box Number
    boxName: "Central Station Hub", // Optional name
    currencySymbol: "₪",
    menuSections: [
      MenuSection(
        id: "menu_drinks_1",
        name: "Cold Drinks", // Section/Menu Name
        priority: 1, // Lower number = higher priority
        products: [
          Product(id: "p1", name: "Cola", formattedPrice: "10.00", priority: 1, tags: ["Popular"]),
          Product(id: "p2", name: "Orange Juice", formattedPrice: "12.00", priority: 2),
          Product(id: "p3", name: "Mineral Water", formattedPrice: "8.00", priority: 3, tags: ["Healthy"]),
        ]..sort((a, b) => a.priority.compareTo(b.priority)), // Sort products by priority
      ),
      MenuSection(
        id: "menu_snacks_1",
        name: "Snacks",
        priority: 2,
        products: [
          Product(id: "p4", name: "Chocolate Bar", formattedPrice: "7.00", priority: 1, tags: ["New"]),
          Product(id: "p5", name: "Crisps", formattedPrice: "9.00", priority: 2),
          Product(id: "p6", name: "Energy Bar", formattedPrice: "11.00", priority: 3, tags: ["Vegan", "Discount_5"]),
        ]..sort((a, b) => a.priority.compareTo(b.priority)),
      ),
       MenuSection(
        id: "menu_hot_1",
        name: "Hot Drinks (Example)",
        priority: 3,
        products: [
          Product(id: "p7", name: "Espresso", formattedPrice: "9.00", priority: 1),
          Product(id: "p8", name: "Cappuccino", formattedPrice: "14.00", priority: 2),
        ]..sort((a, b) => a.priority.compareTo(b.priority)),
      ),
    ]..sort((a, b) => a.priority.compareTo(b.priority)), // Sort sections/menus by priority
  );
});

// --- The Screen Widget ---

class BoxMenuScreen extends ConsumerWidget {
  final String boxId; // Passed via navigation

  const BoxMenuScreen({required this.boxId, Key? key}) : super(key: key);

  @override
  Widget build(BuildContext context, WidgetRef ref) {
    final asyncBoxMenuData = ref.watch(boxMenuDataProvider(boxId));

    return Scaffold(
      appBar: AppBar(
        title: asyncBoxMenuData.when(
          data: (data) => Text('Box ${data.boxNumber} Menu'), // Show Box Number prominently
          loading: () => const Text('Loading Menu...'),
          error: (err, stack) => const Text('Error'),
        ),
        // Add Cart Icon/Button here later
        actions: [
          IconButton(
            icon: const Icon(Icons.shopping_cart_outlined),
            onPressed: () {
              // TODO: Navigate to Cart Screen
              ScaffoldMessenger.of(context).showSnackBar(
                const SnackBar(content: Text('Cart functionality not implemented yet.')),
              );
            },
          ),
        ],
      ),
      body: asyncBoxMenuData.when(
        data: (data) => _buildMenuList(context, data),
        loading: () => const Center(child: CircularProgressIndicator()),
        error: (err, stack) => Center(
          child: Padding(
            padding: const EdgeInsets.all(16.0),
            child: Text(
              'Error loading menu for Box $boxId.\nPlease try again later.\n\n($err)',
              textAlign: TextAlign.center,
            ),
          ),
        ),
      ),
    );
  }

  Widget _buildMenuList(BuildContext context, BoxMenuData data) {
    if (data.menuSections.isEmpty) {
      return const Center(child: Text('No items available at this box currently.'));
    }

    // Using ListView.builder for potentially long menus
    return ListView.builder(
      itemCount: data.menuSections.length,
      itemBuilder: (context, index) {
        final section = data.menuSections[index];
        return _buildMenuSection(context, section, data.currencySymbol);
      },
    );
  }

  Widget _buildMenuSection(BuildContext context, MenuSection section, String currencySymbol) {
    return ExpansionTile( // Use ExpansionTile for collapsibility, or just Column
      title: Text(
        section.name,
        style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold),
      ),
      initiallyExpanded: true, // Start expanded
      children: section.products.map((product) =>
          _buildProductTile(context, product, currencySymbol)
      ).toList(),
      // Add some padding below the section
      childrenPadding: const EdgeInsets.only(bottom: 16.0),
    );

    /* // Alternative: Simple Column layout
    return Padding(
      padding: const EdgeInsets.symmetric(horizontal: 8.0, vertical: 12.0),
      child: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          Text(
            section.name,
            style: Theme.of(context).textTheme.headlineSmall?.copyWith(fontWeight: FontWeight.bold),
          ),
          const SizedBox(height: 8),
          ...section.products.map((product) =>
              _buildProductTile(context, product, currencySymbol)
          ).toList(),
           const Divider(height: 24), // Separator between sections
        ],
      ),
    );
    */
  }

  Widget _buildProductTile(BuildContext context, Product product, String currencySymbol) {
    return ListTile(
      leading: Container(
        width: 60,
        height: 60,
        decoration: BoxDecoration(
          color: Colors.grey[200], // Placeholder background
          borderRadius: BorderRadius.circular(8),
          image: product.imageUrl != null
              ? DecorationImage(
                  image: NetworkImage(product.imageUrl!), // Use NetworkImage for URLs
                  fit: BoxFit.cover,
                  // Add error builder for network images
                  onError: (exception, stackTrace) {
                     // Optionally log error: logger.error('Failed to load image ${product.imageUrl}', exception, stackTrace);
                  },
                )
              : null, // No image if URL is null
        ),
        // Placeholder Icon if no image
         child: product.imageUrl == null
              ? Icon(Icons.fastfood, color: Colors.grey[400])
              : null,
      ),
      title: Text(product.name, style: const TextStyle(fontWeight: FontWeight.w500)),
      subtitle: Column(
        crossAxisAlignment: CrossAxisAlignment.start,
        children: [
          if (product.description != null && product.description!.isNotEmpty)
            Padding(
              padding: const EdgeInsets.only(top: 4.0),
              child: Text(
                product.description!,
                style: Theme.of(context).textTheme.bodySmall,
                maxLines: 2,
                overflow: TextOverflow.ellipsis,
              ),
            ),
          if (product.tags != null && product.tags!.isNotEmpty)
             Padding(
               padding: const EdgeInsets.only(top: 4.0),
               child: Wrap(
                 spacing: 4.0,
                 runSpacing: 2.0,
                 children: product.tags!.map((tag) => Chip(
                   label: Text(tag),
                   padding: EdgeInsets.zero,
                   labelStyle: Theme.of(context).textTheme.labelSmall?.copyWith(fontSize: 10),
                   visualDensity: VisualDensity.compact,
                   backgroundColor: _getTagColor(tag), // Basic tag coloring
                 )).toList(),
               ),
             ),
        ],
      ),
      trailing: Column(
        mainAxisAlignment: MainAxisAlignment.center,
        crossAxisAlignment: CrossAxisAlignment.end,
        children: [
          Text(
            '$currencySymbol${product.formattedPrice}',
            style: const TextStyle(fontWeight: FontWeight.bold, fontSize: 15),
          ),
          const SizedBox(height: 4),
          // Simple Add Button (replace with quantity selector later)
          ElevatedButton(
            onPressed: () {
              // TODO: Implement Add to Cart logic
              ScaffoldMessenger.of(context).showSnackBar(
                 SnackBar(content: Text('Added ${product.name} to cart (not really!)')),
              );
            },
            style: ElevatedButton.styleFrom(
               padding: const EdgeInsets.symmetric(horizontal: 12, vertical: 4),
               minimumSize: Size.zero, // Adjust size
            ),
            child: const Icon(Icons.add, size: 18),
          ),
        ],
      ),
      contentPadding: const EdgeInsets.symmetric(vertical: 8.0, horizontal: 16.0),
      // isThreeLine: product.description != null && product.description!.isNotEmpty,
    );
  }

  // Helper function for basic tag coloring (customize as needed)
  Color _getTagColor(String tag) {
    switch (tag.toLowerCase()) {
      case 'new': return Colors.blue.shade100;
      case 'popular': return Colors.orange.shade100;
      case 'discount_5':
      case 'discount_10': return Colors.green.shade100;
      case 'vegan': return Colors.lightGreen.shade100;
      case 'healthy': return Colors.teal.shade100;
      default: return Colors.grey.shade200;
    }
  }
}

// --- Main App (for testing this screen directly) ---
/*
// Remove this when integrating into the main app
void main() {
  runApp(
    // ProviderScope needed for Riverpod providers
    const ProviderScope(
      child: MaterialApp(
        title: 'Box Menu Test',
        home: BoxMenuScreen(boxId: 'box123'), // Pass a test box ID
      ),
    ),
  );
}
*/

