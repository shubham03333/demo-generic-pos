'use client';

import React, { useState, useEffect, useRef } from 'react';
import { Clock, ChefHat, Edit2, Trash2, X, Save, BarChart3, History, Wifi, WifiOff, ArrowLeft, Menu, Users, Package, Search, Bluetooth } from 'lucide-react';
import { Order, MenuItem, OrderItem, CreateOrderRequest, UpdateOrderRequest, Table, LocalOrder, SyncQueueItem } from '@/types';
import { useOfflineStatus } from '@/hooks/useOfflineStatus';
import { indexedDBManager } from '@/lib/indexeddb';
import { SyncManager } from '@/lib/syncManager';
import GoogleReviewQR from './GoogleReviewQR';
import PendingOrdersSidebar from './PendingOrdersSidebar';
import WaiterPhotoDishCard, { WaiterTextDishCard } from './WaiterPhotoDishCard';
import { readStoredPhotoUrls, storePhotoUrls } from '@/lib/dish-photo-cache';
import PrinterSetupModal from '@/components/PrinterSetupModal';
import { isNativePos, printOrderReceipt } from '@/lib/native-printer';

function isCatalogTableOrder(order: Order) {
  const source = String(order.external_source || '').toLowerCase();
  if (source === 'digital_catalog') return true;
  return order.status === 'pending' && order.order_type === 'DINE_IN';
}

function cafeCalendarDate(offsetDays = 0) {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Kolkata',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(new Date());
  const year = Number(parts.find((part) => part.type === 'year')?.value);
  const month = Number(parts.find((part) => part.type === 'month')?.value);
  const day = Number(parts.find((part) => part.type === 'day')?.value);
  return new Date(Date.UTC(year, month - 1, day + offsetDays)).toISOString().slice(0, 10);
}

function announceCatalogOrder(order: Order) {
  const number = String(order.order_number || '').padStart(3, '0');
  const table = order.table_code || order.table_name || 'the table';
  const guest = String(order.customer_name || '').trim();
  const phrase = guest
    ? `Order ${number} placed from table ${table} by ${guest}`
    : `Order ${number} placed from table ${table}`;
  try {
    const AudioCtx = window.AudioContext || (window as typeof window & { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (AudioCtx) {
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.value = 880;
      gain.gain.value = 0.12;
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.start();
      osc.stop(ctx.currentTime + 0.2);
      window.setTimeout(() => ctx.close().catch(() => undefined), 400);
    }
  } catch {
    // audio optional
  }
  try {
    window.speechSynthesis.cancel();
    const voice = new SpeechSynthesisUtterance(phrase);
    voice.rate = 1;
    voice.lang = 'en-IN';
    window.speechSynthesis.speak(voice);
  } catch {
    // speech optional
  }
}

const CafeOrderSystem = () => {
  const [orders, setOrders] = useState<Order[]>([]);
  const [menuItems, setMenuItems] = useState<MenuItem[]>([]);
  const [buildingOrder, setBuildingOrder] = useState<OrderItem[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [dailySales, setDailySales] = useState(0);
  const [salesData, setSalesData] = useState<any>({ total_revenue: 0, payment_breakdown: { cash: { orders: 0, revenue: 0 }, online: { orders: 0, revenue: 0 } } });
  const [pendingOrdersCount, setPendingOrdersCount] = useState(0);
  const [editingOrder, setEditingOrder] = useState<Order | null>(null);
  const [viewingOrder, setViewingOrder] = useState<Order | null>(null);
  
  // Offline status
  const isOffline = useOfflineStatus();

  // SyncManager instance
  const syncManagerRef = useRef<SyncManager | null>(null);
  
  // Sales report modal state
  const [isReportModalOpen, setIsReportModalOpen] = useState(false);
  const [startDate, setStartDate] = useState('');
  const [endDate, setEndDate] = useState('');
  const [salesReport, setSalesReport] = useState<any>(null);
  const [reportLoading, setReportLoading] = useState(false);

  // Payment revenue modal state
  const [isPaymentRevenueModalOpen, setIsPaymentRevenueModalOpen] = useState(false);
  
  // Confirmation modal state
  const [confirmingDeleteOrder, setConfirmingDeleteOrder] = useState<string | null>(null);
  const [isConfirmModalOpen, setIsConfirmModalOpen] = useState(false);

  // Served orders modal state
  const [isServedOrdersModalOpen, setIsServedOrdersModalOpen] = useState(false);
  const [servedOrders, setServedOrders] = useState<Order[]>([]);
  const [loadingServedOrders, setLoadingServedOrders] = useState(false);
  const [popularItems, setPopularItems] = useState<{name: string; quantity: number}[]>([]);

  // Payment mode selection modal state
  const [isPaymentModeModalOpen, setIsPaymentModeModalOpen] = useState(false);
  const [orderToServe, setOrderToServe] = useState<Order | null>(null);
  const [stockoutItem, setStockoutItem] = useState<MenuItem | null>(null);
  const [stockoutBusy, setStockoutBusy] = useState(false);
  const [stockNotice, setStockNotice] = useState<string | null>(null);
  const [payOfferCode, setPayOfferCode] = useState('');
  const [payPhone, setPayPhone] = useState('');
  const [payPreview, setPayPreview] = useState<{ gross: number; discount: number; net: number; name?: string } | null>(null);
  const [payError, setPayError] = useState<string | null>(null);
  const [payBusy, setPayBusy] = useState(false);
  const [printerSetupOpen, setPrinterSetupOpen] = useState(false);
  const [printBusy, setPrintBusy] = useState(false);
  const [printNotice, setPrintNotice] = useState<string | null>(null);

  // Analytics chart state
  const [showAnalytics, setShowAnalytics] = useState(false);

  // Order flow state management
  const [currentStep, setCurrentStep] = useState<'menu'>('menu');
  const [selectedOrderType, setSelectedOrderType] = useState<'DINE_IN' | 'TAKEAWAY' | 'DELIVERY' | null>('TAKEAWAY');

  // Table filter state for order queue
  const [selectedTableFilter, setSelectedTableFilter] = useState<string | null>(null);
  const [tables, setTables] = useState<Table[]>([]);
  const [isDropdownOpen, setIsDropdownOpen] = useState(false);

  // New UI state for compact menu display
  const [searchTerm, setSearchTerm] = useState('');
  const [searchOpen, setSearchOpen] = useState(false);
  const [selectedCategory, setSelectedCategory] = useState<string | null>(null);
  const [viewMode, setViewMode] = useState<'all' | 'favorites'>('all');
  const [favorites, setFavorites] = useState<number[]>([]);
  const [favoritesReady, setFavoritesReady] = useState(false);
  const [photoMenu, setPhotoMenu] = useState(false);
  const [dishPhotos, setDishPhotos] = useState<Record<number, string>>({});
  const searchInputRef = useRef<HTMLInputElement>(null);

  // Edit order modal search state
  const [editOrderSearchTerm, setEditOrderSearchTerm] = useState('');

  // Sidebar state management
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [pendingSidebarOpen, setPendingSidebarOpen] = useState(false);
  const [qrAlert, setQrAlert] = useState<{ orderNumber: string; table: string; guest?: string } | null>(null);
  const seenOrderIds = useRef<Set<string> | null>(null);
  const audioReady = useRef(false);
  const [selectedTable, setSelectedTable] = useState<any>(null);
  const [tableOrders, setTableOrders] = useState<{ [tableId: string]: OrderItem[] }>({});

  // Swipe gesture state
  const [touchStart, setTouchStart] = useState<number | null>(null);
  const [touchEnd, setTouchEnd] = useState<number | null>(null);

  // Minimum swipe distance (in px) to trigger the gesture
  const minSwipeDistance = 50;
  const ignorePageSwipe = useRef(false);

  function isHorizontalScrollTouch(target: EventTarget | null) {
    let node = target instanceof Element ? target : null;
    while (node && node !== document.body) {
      if (node.getAttribute('data-no-page-swipe') === 'true') return true;
      const style = window.getComputedStyle(node);
      const overflowX = style.overflowX;
      if (
        (overflowX === 'auto' || overflowX === 'scroll') &&
        node.scrollWidth > node.clientWidth + 8
      ) {
        return true;
      }
      node = node.parentElement;
    }
    return false;
  }

  const onTouchStart = (e: React.TouchEvent) => {
    ignorePageSwipe.current = isHorizontalScrollTouch(e.target);
    setTouchEnd(null);
    setTouchStart(e.targetTouches[0].clientX);
  };

  const onTouchMove = (e: React.TouchEvent) => {
    setTouchEnd(e.targetTouches[0].clientX);
  };

  const onTouchEnd = () => {
    if (ignorePageSwipe.current) return;
    if (!touchStart || !touchEnd) return;

    const distance = touchStart - touchEnd;
    const isLeftSwipe = distance > minSwipeDistance;

    if (isLeftSwipe) {
      setPendingSidebarOpen(true);
    }
  };

  // Handle table selection
  const handleTableSelect = (table: Table) => {
    console.log('🔍 handleTableSelect called with table:', table);
    setSelectedTable(table);
    setSelectedOrderType('DINE_IN');
    console.log('🔍 selectedTable set to:', table);
    setCurrentStep('menu');
  };



  // Handle takeaway selection
  const handleTakeawaySelect = () => {
    setSelectedOrderType('TAKEAWAY');
    setSelectedTable(null);
    // Don't clear editingOrder when navigating to menu
    setCurrentStep('menu');
  };

  const formatINR = (value: number | string | null | undefined) =>
    `₹${Number(value || 0).toLocaleString('en-IN')}`;

  const popularNameSet = React.useMemo(
    () => new Set(popularItems.slice(0, 8).map((item) => item.name.toLowerCase())),
    [popularItems]
  );

  const filteredMenuItems = React.useMemo(() => {
    const query = searchTerm.toLowerCase();
    return menuItems.filter((item) => {
      const matchesSearch = item.name.toLowerCase().includes(query);
      const matchesCategory = selectedCategory === null || item.category === selectedCategory;
      const matchesViewMode = viewMode === 'all' || favorites.includes(item.id);
      return matchesSearch && matchesCategory && matchesViewMode;
    });
  }, [menuItems, searchTerm, selectedCategory, viewMode, favorites]);

  const buildingQtyById = React.useMemo(() => {
    const map = new Map<number, number>();
    buildingOrder.forEach((item) => map.set(item.id, item.quantity));
    return map;
  }, [buildingOrder]);

  const buildingTotal = buildingOrder.reduce((sum, item) => sum + item.price * item.quantity, 0);

  const retryDashboardLoad = () => {
    setError(null);
    setLoading(true);
    Promise.all([fetchMenu(), fetchOrders(), fetchTables(), fetchDailySales()]).finally(() => {
      setLoading(false);
    });
  };

  const closeOrderPopup = () => {
    setViewingOrder(null);
  };
  
  const handleOrderClick = (order: Order) => {
    setViewingOrder(order);
  };

  // Fetch menu items and set up real-time updates with optimized polling
  useEffect(() => {
    // Instantiate SyncManager
    syncManagerRef.current = new SyncManager();

    fetchMenu();
    fetchOrders();
    fetchTables();
    fetchPopularItems();
    fetchDailySales();

    const ordersPollingInterval = setInterval(() => {
      fetchOrders();
      fetchTables();
    }, 5000);

    const salesPollingInterval = setInterval(() => {
      fetchDailySales();
    }, 15000);

    const menuPollingInterval = setInterval(() => {
      fetchMenu();
    }, 30000);

    // Listen for order update events (e.g., payment status changes)
    const handleOrderUpdate = () => {
      console.log('Order update detected, refreshing orders...');
      fetchOrders();
    };

    window.addEventListener('orderUpdated', handleOrderUpdate);

    // Memory monitoring in development
    let memoryCheckInterval: NodeJS.Timeout | null = null;
    if (process.env.NODE_ENV === 'development') {
      memoryCheckInterval = setInterval(() => {
        if (typeof window !== 'undefined' && (window as any).performance?.memory) {
          const memInfo = (window as any).performance.memory;
          const usedMB = Math.round(memInfo.usedJSHeapSize / 1024 / 1024);
          if (usedMB > 100) { // Log when browser memory exceeds 100MB
            console.warn(`⚠️ High browser memory usage: ${usedMB}MB`);
          }
        }
      }, 60000); // Check every minute
    }

    // Clean up intervals and event listener on component unmount
    return () => {
      clearInterval(ordersPollingInterval);
      clearInterval(salesPollingInterval);
      clearInterval(menuPollingInterval);
      if (memoryCheckInterval) {
        clearInterval(memoryCheckInterval);
      }
      window.removeEventListener('orderUpdated', handleOrderUpdate);
    };
  }, []);

  useEffect(() => {
    try {
      const saved = localStorage.getItem('adda-menu-favorites');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) {
          setFavorites(parsed.filter((id: unknown) => typeof id === 'number'));
        }
      }
    } catch {
      // ignore corrupt favorites
    }
    setFavoritesReady(true);
  }, []);

  useEffect(() => {
    try {
      setPhotoMenu(localStorage.getItem('adda-waiter-menu-style') === 'photo');
      setDishPhotos(readStoredPhotoUrls());
    } catch {
      // ignore
    }
  }, []);

  useEffect(() => {
    if (!photoMenu) return;
    let cancelled = false;
    void fetch('/api/menu/photos')
      .then((response) => response.json())
      .then((data) => {
        if (cancelled || !data?.photos) return;
        storePhotoUrls(data.photos);
        const next: Record<number, string> = {};
        for (const [key, value] of Object.entries(data.photos as Record<string, string>)) {
          const id = Number(key);
          if (Number.isInteger(id) && value) next[id] = value;
        }
        setDishPhotos(next);
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [photoMenu]);

  useEffect(() => {
    if (!favoritesReady) return;
    localStorage.setItem('adda-menu-favorites', JSON.stringify(favorites));
  }, [favorites, favoritesReady]);

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        if (stockoutItem) {
          setStockoutItem(null);
          return;
        }
        if (isPaymentModeModalOpen) {
          closePaymentModeModal();
          return;
        }
        if (isConfirmModalOpen) {
          closeConfirmModal();
          return;
        }
        if (viewingOrder) {
          closeOrderPopup();
          return;
        }
        if (editingOrder) {
          cancelEdit();
          return;
        }
        if (isReportModalOpen) {
          closeReportModal();
          return;
        }
        if (isServedOrdersModalOpen) {
          closeServedOrdersModal();
          return;
        }
        if (isPaymentRevenueModalOpen) {
          closePaymentRevenueModal();
          return;
        }
        if (pendingSidebarOpen) {
          setPendingSidebarOpen(false);
          return;
        }
        if (sidebarOpen) {
          setSidebarOpen(false);
          return;
        }
        if (searchOpen) {
          setSearchOpen(false);
          setSearchTerm('');
          return;
        }
        return;
      }

      if (event.key === '/' && !event.ctrlKey && !event.metaKey && !event.altKey) {
        const target = event.target as HTMLElement | null;
        if (target && (target.tagName === 'INPUT' || target.tagName === 'TEXTAREA' || target.isContentEditable)) {
          return;
        }
        event.preventDefault();
        setSearchOpen(true);
      }
    };

    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [
    isPaymentModeModalOpen,
    isConfirmModalOpen,
    viewingOrder,
    editingOrder,
    isReportModalOpen,
    isServedOrdersModalOpen,
    isPaymentRevenueModalOpen,
    pendingSidebarOpen,
    sidebarOpen,
    searchOpen,
    stockoutItem,
  ]);

  useEffect(() => {
    if (searchOpen) searchInputRef.current?.focus();
  }, [searchOpen]);

  const fetchMenu = async () => {
    try {
      const response = await fetch('/api/menu?availableOnly=true');
      if (!response.ok) throw new Error('Failed to fetch menu');
      const data = await response.json();
      setMenuItems(data);
      setBuildingOrder((prev) => prev.filter((line) => !data.find((item: MenuItem) => item.id === line.id)?.out_of_stock));
    } catch (err) {
      setError('Failed to load menu');
      console.error(err);
    }
  };

  const fetchDailySales = async () => {
    try {
      const response = await fetch('/api/daily-sales/today');
      if (!response.ok) throw new Error('Failed to fetch daily sales');
      const data = await response.json();
      setSalesData(data);
      setDailySales(data.total_revenue);
    } catch (err) {
      console.error('Failed to fetch daily sales:', err);
      setSalesData({ total_revenue: 0, payment_breakdown: { cash: { orders: 0, revenue: 0 }, online: { orders: 0, revenue: 0 } } });
      setDailySales(0); // Reset to 0 on error
    }
  };



  const fetchPopularItems = async () => {
    try {
      // Get last 7 days for popular items
      const endDate = new Date();
      const startDate = new Date();
      startDate.setDate(startDate.getDate() - 7);

      const response = await fetch(`/api/sales-report?startDate=${startDate.toISOString().split('T')[0]}&endDate=${endDate.toISOString().split('T')[0]}`);
      if (!response.ok) throw new Error('Failed to fetch popular items');
      const data = await response.json();
      setPopularItems(data.top_items || []);
    } catch (err) {
      console.error('Failed to fetch popular items:', err);
    }
  };

  const fetchTables = async () => {
    try {
      const response = await fetch('/api/tables');
      if (!response.ok) throw new Error('Failed to fetch tables');
      const data = await response.json();
      setTables(data);
    } catch (err) {
      console.error('Failed to fetch tables:', err);
    }
  };

  const ordersContainerRef = useRef<HTMLDivElement>(null);

  const fetchOrders = async () => {
    const scrollPosition = ordersContainerRef.current?.scrollTop || 0; // Store current scroll position
    try {
    const response = await fetch('/api/orders'); // Remove ?includeServed=true to only get non-served orders
    if (!response.ok) throw new Error('Failed to fetch orders');
    const data = await response.json();
    // Handle paginated response structure
    const ordersArray = Array.isArray(data.orders) ? data.orders : Array.isArray(data) ? data : []; // Ensure it's always an array
    setOrders(ordersArray);

    if (seenOrderIds.current === null) {
      seenOrderIds.current = new Set(ordersArray.map((order: Order) => order.id));
    } else {
      const fresh = ordersArray.filter(
        (order: Order) => !seenOrderIds.current!.has(order.id) && isCatalogTableOrder(order)
      );
      for (const order of fresh) {
        announceCatalogOrder(order);
        setQrAlert({
          orderNumber: String(order.order_number).padStart(3, '0'),
          table: order.table_code || order.table_name || 'table',
          guest: order.customer_name || undefined,
        });
      }
      for (const order of ordersArray) {
        seenOrderIds.current.add(order.id);
      }
    }

    // Calculate pending orders count (orders that are not served)
    const pendingOrders = ordersArray.filter((order: Order) => order.status !== 'served');
    setPendingOrdersCount(pendingOrders.length);

    setLoading(false);

    if (ordersContainerRef.current) {
        ordersContainerRef.current.scrollTop = scrollPosition; // Restore scroll position
    }
    } catch (err) {
      setError('Failed to load orders');
      setLoading(false);
      console.error(err);
    }
  };

  const addToOrder = (item: MenuItem, quantity: number) => {
    if (item.out_of_stock) {
      setStockNotice('This item is out of stock for today. Hold 3 seconds to mark it back in stock.');
      window.setTimeout(() => setStockNotice(null), 3500);
      return;
    }
    if (!selectedTable && selectedOrderType !== 'TAKEAWAY') return;
    setBuildingOrder(prev => {
      const existing = prev.find(p => p.id === item.id);
      if (existing) {
        return prev.map(p => p.id === item.id ? {...p, quantity: p.quantity + quantity} : p);
      }
      return [...prev, { ...item, quantity }];
    });
  };

  const applyStockoutResult = (id: number, outOfStock: boolean, stockoutDate: string | null) => {
    setMenuItems((prev) =>
      prev.map((item) =>
        item.id === id ? { ...item, out_of_stock: outOfStock, stockout_date: stockoutDate } : item
      )
    );
    if (outOfStock) {
      setBuildingOrder((prev) => prev.filter((line) => line.id !== id));
    }
  };

  const confirmStockoutToggle = async () => {
    if (!stockoutItem) return;
    const nextOut = !stockoutItem.out_of_stock;
    setStockoutBusy(true);
    try {
      const response = await fetch(`/api/menu/${stockoutItem.id}/stockout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ out: nextOut }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setStockNotice(data.error || 'Could not update stock. Run add-daily-stockout.sql on TiDB if needed.');
        window.setTimeout(() => setStockNotice(null), 5000);
        return;
      }
      applyStockoutResult(stockoutItem.id, Boolean(data.out_of_stock), data.stockout_date ?? null);
      setStockoutItem(null);
    } catch (error) {
      console.error(error);
      setStockNotice('Could not update stock.');
      window.setTimeout(() => setStockNotice(null), 3500);
    } finally {
      setStockoutBusy(false);
    }
  };

  const placeOrder = async () => {
    if (buildingOrder.length === 0) return;

    try {
      const total = buildingOrder.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      const localOrderId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

      // Create local order object
      const localOrder: LocalOrder = {
        local_order_id: localOrderId,
        order_number: undefined, // Will be assigned by server when synced
        items: buildingOrder,
        total,
        status: 'pending',
        payment_status: 'pending',
        order_time: new Date().toISOString(),
        order_type: selectedTable ? 'DINE_IN' : selectedOrderType || 'TAKEAWAY',
        table_id: selectedTable?.table_code,
        table_code: selectedTable?.table_code,
        sync_status: isOffline ? 'pending' : 'syncing',
        sync_attempts: 0,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };

      if (isOffline) {
        // Offline mode: Save locally and queue for sync
        console.log('Offline mode: Saving order locally');
        await indexedDBManager.saveLocalOrder(localOrder);
        await syncManagerRef.current?.addOrderToSyncQueue(localOrder);

        // Clear building order and show success message
        setBuildingOrder([]);
        setError(null); // Clear any previous errors

        // Show offline success message (you could add a toast notification here)
        console.log('Order saved locally and queued for sync when connection is restored');

        // Refresh local orders display
        await fetchOrders();

      } else {
        // Online mode: Try to place order directly
        console.log('Online mode: Placing order directly');

        const orderData: CreateOrderRequest = {
          items: buildingOrder,
          total,
          order_type: selectedTable ? 'DINE_IN' : 'TAKEAWAY',
          table_id: selectedTable?.table_code || null
        };

        const response = await fetch('/api/orders', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(orderData)
        });

        if (!response.ok) {
          // If API fails, fall back to offline mode
          console.log('API failed, falling back to offline mode');
          await indexedDBManager.saveLocalOrder(localOrder);
          await syncManagerRef.current?.addOrderToSyncQueue(localOrder);
          setBuildingOrder([]);
          await fetchOrders();
          return;
        }

        // Success: Clear building order and refresh
        setBuildingOrder([]);
        // Store items in table orders state only for dine-in orders
        if (selectedTable && selectedTable.id && selectedOrderType === 'DINE_IN') {
          setTableOrders(prev => ({
            ...prev,
            [selectedTable.id]: [...(prev[selectedTable.id] || []), ...buildingOrder]
          }));
        }
        await fetchOrders();
      }

    } catch (err) {
      console.error('Failed to place order:', err);

      // If we get here, try to save locally as fallback
      try {
        const total = buildingOrder.reduce((sum, item) => sum + (item.price * item.quantity), 0);
        const localOrderId = `local_${Date.now()}_${Math.random().toString(36).substr(2, 9)}`;

        const localOrder: LocalOrder = {
          local_order_id: localOrderId,
          order_number: undefined,
          items: buildingOrder,
          total,
          status: 'pending',
          payment_status: 'pending',
          order_time: new Date().toISOString(),
          order_type: selectedOrderType || 'DINE_IN',
          table_id: selectedTable?.table_code || null,
          table_code: selectedTable?.table_code || null,
          sync_status: 'pending',
          sync_attempts: 0,
          created_at: new Date().toISOString(),
          updated_at: new Date().toISOString()
        };

        await indexedDBManager.saveLocalOrder(localOrder);
        await syncManagerRef.current?.addOrderToSyncQueue(localOrder);
        setBuildingOrder([]);
        await fetchOrders();

        console.log('Order saved locally due to error');
      } catch (fallbackErr) {
        console.error('Failed to save order locally:', fallbackErr);
        setError('Failed to place order and unable to save locally');
      }
    }
  };

  const updateOrderStatus = async (orderId: string, status: Order['status']) => {
    try {
      const updateData: UpdateOrderRequest = { status, items: orders.find(order => order.id === orderId)?.items };

      const response = await fetch(`/api/orders/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      });

      if (!response.ok) throw new Error('Failed to update order');
      // and also force a refresh to ensure consistency with the backend
      if (status === 'served') {
        setOrders(prevOrders => prevOrders.filter(order => order.id !== orderId));
        setPendingOrdersCount(prev => prev - 1);
        await fetchDailySales();
        
        // Force an immediate refresh to ensure UI is in sync with backend
        setTimeout(() => {
          fetchOrders();
        }, 100);
      } else {
        await fetchOrders(); // Refresh orders for other status changes
      }
      
    } catch (err) {
      setError('Failed to update order');
      console.error(err);
    }
  };

  const acceptQrOrder = async (order: Order) => {
    await updateOrderStatus(order.id, 'preparing');
  };

  const updateTableQrSession = async (table: Table, action: 'open' | 'close') => {
    try {
      const response = await fetch(`/api/tables/${table.id}/qr-session`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action }),
      });
      if (!response.ok) throw new Error('Failed to update QR session');
      await fetchTables();
    } catch (err) {
      setError('Failed to update table QR ordering');
      console.error(err);
    }
  };

  const deleteOrder = async (orderId: string) => {
    try {
      const response = await fetch(`/api/orders/${orderId}`, {
        method: 'DELETE'
      });

      if (!response.ok) throw new Error('Failed to delete order');

      await fetchOrders(); // Refresh orders
      
    } catch (err) {
      setError('Failed to delete order');
      console.error(err);
    }
  };

  const saveEditedOrder = async () => {
    if (!editingOrder || editingOrder.items.length === 0) {
      if (editingOrder) await deleteOrder(editingOrder.id);
      setEditingOrder(null);
      return;
    }

    try {
      const updateData: UpdateOrderRequest = {
        items: editingOrder.items,
        total: editingOrder.total
      };

      const response = await fetch(`/api/orders/${editingOrder.id}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      });

      if (!response.ok) throw new Error('Failed to save order');

      // Update the bill view with the latest changes if it's currently open
      setViewingOrder(editingOrder);
      setEditingOrder(null);
      await fetchOrders(); // Refresh orders

    } catch (err) {
      setError('Failed to save order');
      console.error(err);
    }
  };

  const removeItemFromBuildingOrder = (itemId: number) => {
    setBuildingOrder(prev => prev.filter(item => item.id !== itemId));
  };

  const updateBuildingOrderItemQuantity = (itemId: number, newQuantity: number) => {
    if (newQuantity <= 0) {
      // Remove item if quantity is 0 or less
      setBuildingOrder(prev => prev.filter(item => item.id !== itemId));
    } else {
      // Update quantity
      setBuildingOrder(prev => prev.map(item => 
        item.id === itemId ? { ...item, quantity: newQuantity } : item
      ));
    }
  };

  const removeItemFromOrder = async (orderId: string, itemId: number) => {
    try {
      const orderToUpdate = orders.find(order => order.id === orderId);
      if (!orderToUpdate) return;

      const updatedItems = orderToUpdate.items.filter(item => item.id !== itemId);
      const total = updatedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);

      const updateData: UpdateOrderRequest = {
        items: updatedItems,
        total
      };

      const response = await fetch(`/api/orders/${orderId}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(updateData)
      });

      if (!response.ok) throw new Error('Failed to remove item from order');

      await fetchOrders(); // Refresh orders
      
    } catch (err) {
      setError('Failed to remove item from order');
      console.error(err);
    }
  };

  const editOrder = (order: Order) => {
    setEditingOrder(order);
  };

  const cancelEdit = () => {
    setEditingOrder(null);
  };

  const updateEditingOrderItem = (itemId: number, newQuantity: number) => {
    if (!editingOrder) return;
    
    if (newQuantity <= 0) {
      // Remove item if quantity is 0 or less
      const updatedItems = editingOrder.items.filter(item => item.id !== itemId);
      const total = updatedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      setEditingOrder({ ...editingOrder, items: updatedItems, total });
    } else {
      // Update quantity
      const updatedItems = editingOrder.items.map(item => 
        item.id === itemId ? { ...item, quantity: newQuantity } : item
      );
      const total = updatedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
      setEditingOrder({ ...editingOrder, items: updatedItems, total });
    }
  };

  const addItemToEditingOrder = (item: MenuItem) => {
    if (!editingOrder) return;
    
    const existingItem = editingOrder.items.find(i => i.id === item.id);
    let updatedItems;
    
    if (existingItem) {
      updatedItems = editingOrder.items.map(i => 
        i.id === item.id ? { ...i, quantity: i.quantity + 1 } : i
      );
    } else {
      updatedItems = [...editingOrder.items, { ...item, quantity: 1 }];
    }
    
    const total = updatedItems.reduce((sum, item) => sum + (item.price * item.quantity), 0);
    setEditingOrder({ ...editingOrder, items: updatedItems, total });
  };

  // Sales report functions
  const generateSalesReport = async (day = cafeCalendarDate(-1)) => {
    setReportLoading(true);
    try {
      const response = await fetch(`/api/sales-report?startDate=${day}&endDate=${day}`);
      if (!response.ok) throw new Error('Failed to generate sales report');
      const data = await response.json();
      setSalesReport(data);
    } catch (err) {
      setError('Failed to load yesterday’s sales');
      console.error(err);
    } finally {
      setReportLoading(false);
    }
  };

  const openReportModal = () => {
    const yesterday = cafeCalendarDate(-1);
    setStartDate(yesterday);
    setEndDate(yesterday);
    setSalesReport(null);
    setIsReportModalOpen(true);
    void generateSalesReport(yesterday);
  };

  const closeReportModal = () => {
    setIsReportModalOpen(false);
    setSalesReport(null);
    setReportLoading(false);
  };

  // Payment revenue modal functions
  const openPaymentRevenueModal = () => {
    setIsPaymentRevenueModalOpen(true);
  };

  const closePaymentRevenueModal = () => {
    setIsPaymentRevenueModalOpen(false);
  };

  // Confirmation modal functions
  const openConfirmModal = (orderId: string) => {
    setConfirmingDeleteOrder(orderId);
    setIsConfirmModalOpen(true);
  };

  const closeConfirmModal = () => {
    setIsConfirmModalOpen(false);
    setConfirmingDeleteOrder(null);
  };

  const handleConfirmDelete = async () => {
    if (confirmingDeleteOrder) {
      await deleteOrder(confirmingDeleteOrder);
      closeConfirmModal();
    }
  };

  // Served orders functions
  const fetchServedOrders = async () => {
    setLoadingServedOrders(true);
    try {
      const response = await fetch('/api/orders?status=served');
      if (!response.ok) throw new Error('Failed to fetch served orders');
      const data = await response.json();
      // Handle paginated response structure
      const ordersArray = Array.isArray(data.orders) ? data.orders : Array.isArray(data) ? data : [];
      // Filter only served orders and get the most recent 5
      const served = ordersArray.filter((order: Order) => order.status === 'served');
      setServedOrders(served.slice(0, 5)); // Get first 5 (most recent) served orders
    } catch (err) {
      setError('Failed to fetch served orders');
      console.error(err);
    } finally {
      setLoadingServedOrders(false);
    }
  };

  const openServedOrdersModal = async () => {
    setIsServedOrdersModalOpen(true);
    await fetchServedOrders();
  };

  const closeServedOrdersModal = () => {
    setIsServedOrdersModalOpen(false);
    setServedOrders([]);
  };

  // Payment mode functions
  const openPaymentModeModal = (order: Order) => {
    setOrderToServe(order);
    setPayOfferCode(order.offer_code || '');
    setPayPhone(order.customer_phone || '');
    setPayPreview(null);
    setPayError(null);
    setIsPaymentModeModalOpen(true);
  };

  const closePaymentModeModal = () => {
    setIsPaymentModeModalOpen(false);
    setOrderToServe(null);
    setPayOfferCode('');
    setPayPhone('');
    setPayPreview(null);
    setPayError(null);
    setPayBusy(false);
  };

  const printWithBrowserFallback = (order: Order) => {
    const domain = process.env.NEXT_PUBLIC_PRODUCTION_DOMAIN;
    if (!domain) {
      alert('Printer domain not configured');
      return;
    }
    const printUrl = `my.bluetoothprint.scheme://https://${domain}/api/print/order/${order.id}`;
    const link = document.createElement('a');
    link.href = printUrl;
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    openPaymentModeModal(order);
  };

  const handlePosPrint = async (order: Order) => {
    setPrintBusy(true);
    setPrintNotice(null);
    try {
      if (await isNativePos()) {
        const result = await printOrderReceipt(order);
        if (result.ok) {
          setPrintNotice('Printed');
          openPaymentModeModal(order);
          return;
        }
        if ('needSetup' in result && result.needSetup) {
          setPrintNotice(result.message);
          setPrinterSetupOpen(true);
          return;
        }
        setPrintNotice(result.message);
        return;
      }
      printWithBrowserFallback(order);
    } catch (err) {
      console.error(err);
      setPrintNotice('Print failed');
    } finally {
      setPrintBusy(false);
    }
  };

  const printBill = (order: Order) => {
  const printWindow = window.open('', '_blank', 'width=400,height=600');

  if (!printWindow) return;

  printWindow.document.write(`
    <html>
      <head>
        <title>Bill</title>
        <meta name="viewport" content="width=device-width, initial-scale=1.0">
        <style>
   body {
  margin: 0;
  padding: 0;
  font-family: monospace;
  width: 58mm;
}

.bill {
  padding: 6px;
  font-size: 12px;
  color: black;
}

          @page {
            size: 58mm auto;
            margin: 0;
          }

          body {
            margin: 0;
            padding: 0;
            font-family: monospace;
            width: 58mm;
          }

          .bill {
            padding: 8px;
            font-size: 12px;
            color: #000;
          }

          .center {
            text-align: center;
          }

          .row {
            display: flex;
            justify-content: space-between;
            margin: 2px 0;
          }

          .bold {
            font-weight: bold;
          }

          .divider {
            border-top: 1px dashed #000;
            margin: 6px 0;
          }
        </style>
      </head>
      <body>
        <div class="bill">
          <div class="center">
            
          </div>
          <div class="center bold">Adda Cafe</div>
          <div class="center">Order #${order.order_number}</div>
          <div class="center">${new Date().toLocaleString()}</div>

          <div class="divider"></div>

          ${order.items
            .map(
              i => `
                <div class="row">
                  <span>${i.quantity} x ${i.name}</span>
                  <span>₹${i.price * i.quantity}</span>
                </div>
              `
            )
            .join('')}

          <div class="divider"></div>

          ${Number(order.discount_total) > 0 ? `
          <div class="row">
            <span>GROSS</span>
            <span>₹${order.gross_total ?? order.total}</span>
          </div>
          <div class="row">
            <span>DISCOUNT${order.offer_code ? ` (${order.offer_code})` : ''}</span>
            <span>-₹${order.discount_total}</span>
          </div>
          <div class="row bold">
            <span>NET</span>
            <span>₹${order.total}</span>
          </div>
          ` : `
          <div class="row bold">
            <span>TOTAL</span>
            <span>₹${order.total}</span>
          </div>
          `}

          <div class="divider"></div>

          <div class="center">Thank you!</div>
          <div class="center">Visit again</div>
        </div>

        <script>
         window.onload = () => {
  setTimeout(() => {
    window.print();
    window.close();
  }, 500);
};

        </script>
      </body>
    </html>
  `);

  printWindow.document.close();
};


  const previewPayOffer = async () => {
    if (!orderToServe || !payOfferCode.trim()) {
      setPayPreview(null);
      return;
    }
    setPayBusy(true);
    setPayError(null);
    try {
      const response = await fetch('/api/offers/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          code: payOfferCode,
          customer_phone: payPhone,
          order_id: orderToServe.id,
        }),
      });
      const data = await response.json().catch(() => ({}));
      if (!response.ok) {
        setPayPreview(null);
        setPayError(data.error || 'Could not apply this code');
        return;
      }
      setPayPreview({
        gross: Number(data.gross),
        discount: Number(data.discount),
        net: Number(data.net),
        name: data.offer?.name,
      });
    } catch (err) {
      setPayPreview(null);
      setPayError('Could not preview offer');
      console.error(err);
    } finally {
      setPayBusy(false);
    }
  };

  const handlePaymentModeSelection = async (paymentMode: 'cash' | 'online') => {
    if (!orderToServe) return;
    setPayBusy(true);
    setPayError(null);

    try {
      const paymentResponse = await fetch(`/api/orders/${orderToServe.id}/pay`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          paymentMode,
          offerCode: payOfferCode.trim() || undefined,
          customerPhone: payPhone.trim() || undefined,
        })
      });
      const data = await paymentResponse.json().catch(() => ({}));

      if (!paymentResponse.ok) {
        setPayError(data.error || 'Failed to process payment');
        return;
      }

      await updateOrderStatus(orderToServe.id, 'served');

      closePaymentModeModal();
      closeOrderPopup();
    } catch (err) {
      setPayError('Failed to process payment and serve order');
      console.error(err);
    } finally {
      setPayBusy(false);
    }
  };

  // Menu step
  if (loading) {
    return (
      <div className="min-h-screen bg-gray-100 p-2 sm:p-4 max-w-md mx-auto">
        {/* Header Skeleton */}
        <div className="bg-gradient-to-r from-red-600 to-red-800 rounded-lg shadow-lg p-3 sm:p-4 mb-4">
          <div className="flex flex-col sm:flex-row justify-between items-center gap-3 sm:gap-4">
            <div className="flex items-center gap-3">
              <div className="w-16 h-16 sm:w-20 sm:h-20 bg-red-400/30 rounded-lg animate-pulse"></div>
            </div>
            <div className="flex items-center gap-2 sm:gap-3 flex-wrap justify-center">
              <div className="p-1.5 sm:p-2 bg-white/20 rounded-lg w-8 h-8 sm:w-10 sm:h-10 animate-pulse"></div>
              <div className="bg-white/20 backdrop-blur-sm rounded-lg p-1.5 sm:p-2 min-w-[50px] sm:min-w-[60px] animate-pulse">
                <div className="h-3 bg-white/30 rounded mb-1"></div>
                <div className="h-6 bg-white/40 rounded"></div>
              </div>
              <div className="bg-white/20 backdrop-blur-sm rounded-lg p-1.5 sm:p-2 min-w-[50px] sm:min-w-[60px] animate-pulse">
                <div className="h-3 bg-white/30 rounded mb-1"></div>
                <div className="h-6 bg-white/40 rounded"></div>
              </div>
              <div className="p-1.5 sm:p-2 bg-white/20 rounded-lg w-8 h-8 sm:w-10 sm:h-10 animate-pulse"></div>
              <div className="p-1.5 sm:p-2 bg-white/20 rounded-lg w-8 h-8 sm:w-10 sm:h-10 animate-pulse"></div>
            </div>
          </div>
        </div>

        {/* Menu Grid Skeleton */}
        <div className="bg-white rounded-lg shadow-lg p-4 mb-4">
          <div className="h-6 bg-gray-200 rounded w-1/3 mb-4 animate-pulse"></div>
          <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 gap-2">
            {[...Array(8)].map((_, index) => (
              <div
                key={index}
                className="w-full p-1.5 sm:p-2 rounded-lg min-h-[60px] sm:min-h-[70px] bg-gray-200 animate-pulse"
              ></div>
            ))}
          </div>
        </div>

        {/* Order Queue Skeleton */}
        <div className="bg-white rounded-lg shadow-lg p-4">
          <div className="h-6 bg-gray-200 rounded w-1/2 mb-4 animate-pulse flex items-center gap-2">
            <div className="w-6 h-6 bg-gray-300 rounded"></div>
          </div>
          <div className="space-y-3">
            {[...Array(3)].map((_, index) => (
              <div
                key={index}
                className="p-4 sm:p-5 rounded-lg bg-gray-100 border-l-4 border-gray-300 animate-pulse"
              >
                <div className="flex justify-between items-start mb-3">
                  <div className="flex items-center gap-2 sm:gap-3">
                    <div className="w-5 h-5 sm:w-6 sm:h-6 bg-gray-300 rounded"></div>
                    <div className="h-6 bg-gray-300 rounded w-12"></div>
                    <div className="h-6 bg-gray-300 rounded w-16"></div>
                  </div>
                  <div className="h-6 bg-gray-300 rounded w-16"></div>
                </div>
                <div className="mb-3 sm:mb-4 space-y-2">
                  {[...Array(2)].map((_, itemIndex) => (
                    <div key={itemIndex} className="flex justify-between items-center py-1 sm:py-2">
                      <div className="h-4 bg-gray-300 rounded w-3/4"></div>
                      <div className="w-4 h-4 bg-gray-300 rounded"></div>
                    </div>
                  ))}
                </div>
                <div className="flex gap-2">
                  <div className="h-8 bg-gray-300 rounded w-16"></div>
                  <div className="h-8 bg-gray-300 rounded flex-1"></div>
                  <div className="h-8 bg-gray-300 rounded w-8"></div>
                </div>
              </div>
            ))}
          </div>
        </div>
      </div>
    );
  }

  if (error) {
    return (
      <div className="min-h-screen bg-gray-100 flex items-center justify-center p-4">
        <div className="text-center text-red-600 max-w-sm">
          <div className="text-xl font-bold mb-2">Could not load the dashboard</div>
          <div className="text-sm text-gray-600 mb-4">{error}</div>
          <button
            type="button"
            onClick={retryDashboardLoad}
            className="mt-2 px-4 py-2 bg-red-600 text-white rounded-lg w-full sm:w-auto min-h-[44px]"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  return (
    <div
      className={`min-h-screen bg-gray-100 p-0.5 sm:p-1 md:p-2 lg:p-4 xl:p-6 w-full max-w-full mx-auto transition-all duration-300 overflow-x-hidden ${buildingOrder.length > 0 ? 'pb-28 md:pb-6' : ''}`}
      onClick={() => {
        if (!audioReady.current) {
          audioReady.current = true;
          try {
            window.speechSynthesis.getVoices();
          } catch {
            // ignore
          }
        }
      }}
      onTouchStart={onTouchStart}
      onTouchMove={onTouchMove}
      onTouchEnd={onTouchEnd}
    >
      {stockNotice && (
        <div className="mb-2 rounded-lg bg-red-50 px-3 py-2 text-sm font-medium text-red-800" role="status">
          {stockNotice}
        </div>
      )}

      {isOffline && (
        <div className="mb-2 flex items-center justify-center gap-2 rounded-lg bg-amber-100 px-3 py-2 text-sm font-medium text-amber-900" role="status">
          <WifiOff className="h-4 w-4" aria-hidden="true" />
          You are offline. New orders will sync when the connection returns.
        </div>
      )}

      {qrAlert ? (
        <div className="fixed inset-0 z-[70] flex items-center justify-center bg-black/40 p-4 print:hidden">
          <div
            role="alertdialog"
            aria-labelledby="qr-alert-title"
            className="relative w-full max-w-sm rounded-2xl bg-white p-5 shadow-2xl"
          >
            <button
              type="button"
              onClick={() => setQrAlert(null)}
              className="absolute right-3 top-3 flex h-9 w-9 items-center justify-center rounded-full text-gray-500 hover:bg-gray-100 hover:text-gray-800"
              aria-label="Close"
            >
              <X className="h-5 w-5" />
            </button>
            <p className="text-xs font-semibold uppercase tracking-wide text-amber-700">QR table order</p>
            <p id="qr-alert-title" className="mt-2 pr-8 text-xl font-black text-gray-900">
              Order #{qrAlert.orderNumber}
            </p>
            <p className="mt-1 text-base font-semibold text-gray-700">
              Table {qrAlert.table}
              {qrAlert.guest ? ` · ${qrAlert.guest}` : ''}
            </p>
          </div>
        </div>
      ) : null}

      {/* Header */}
      <div className="bg-gradient-to-r from-red-600 to-red-800 rounded-lg shadow-lg p-2 sm:p-3 md:p-4 mb-2 sm:mb-3 md:mb-4 transition-all duration-300">
        <div className="flex flex-col sm:flex-row justify-between items-center gap-2 sm:gap-3 md:gap-4">
          <div className="flex items-center gap-2 sm:gap-3 min-w-0">
            <button
              type="button"
              onClick={() => {
                setPhotoMenu((prev) => {
                  const next = !prev;
                  try {
                    localStorage.setItem('adda-waiter-menu-style', next ? 'photo' : 'minimal');
                  } catch {
                    // ignore
                  }
                  return next;
                });
              }}
              className="rounded-lg focus:outline-none focus:ring-2 focus:ring-white/70"
              title={photoMenu ? 'Switch to simple menu' : 'Switch to photo menu'}
              aria-label={photoMenu ? 'Switch to simple menu' : 'Switch to photo menu'}
            >
              <img src="/logo.png" alt="Adda Cafe" className="w-10 h-10 sm:w-14 sm:h-14 md:w-16 md:h-16 lg:w-20 lg:h-20 pointer-events-none" />
            </button>
          </div>
          <div className="flex items-center gap-0.5 flex-wrap justify-center max-w-full overflow-x-auto px-1">
            <button
              type="button"
              onClick={() => setSidebarOpen(true)}
              className="p-1.5 sm:p-2.5 bg-white/20 hover:bg-white/30 text-white rounded-xl transition-colors shadow-md min-h-[44px] min-w-[44px] flex items-center justify-center flex-shrink-0"
              title="Table Management"
              aria-label="Open table management"
            >
              <Menu className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
            <a
              href="/chef"
              className="p-1.5 sm:p-2.5 bg-white text-red-600 rounded-lg text-xs sm:text-sm hover:bg-gray-100 transition-colors shadow-md flex items-center justify-center min-h-[44px] min-w-[44px] flex-shrink-0"
              title="Chef Dashboard"
              aria-label="Open chef dashboard"
            >
              <ChefHat className="w-4 h-4 sm:w-5 sm:h-5" />
            </a>
            <button
              type="button"
              className="bg-white/20 backdrop-blur-sm rounded-lg p-1.5 sm:p-2.5 min-w-[50px] sm:min-w-[64px] cursor-pointer hover:bg-white/30 transition-colors min-h-[44px] flex flex-col items-center justify-center flex-shrink-0"
              onClick={() => setPendingSidebarOpen(true)}
              title="Click to view pending orders"
              aria-label={`View ${pendingOrdersCount} pending orders`}
            >
              <div className="text-[10px] sm:text-xs text-white/90">Pending</div>
              <div className="text-sm sm:text-lg font-bold text-white">{pendingOrdersCount}</div>
            </button>
            <button
              type="button"
              className="bg-white/20 backdrop-blur-sm rounded-lg p-1.5 sm:p-2.5 min-w-[50px] sm:min-w-[64px] cursor-pointer hover:bg-white/30 min-h-[44px] flex flex-col items-center justify-center flex-shrink-0"
              onClick={openPaymentRevenueModal}
              title="Today's sales"
              aria-label={`Today's sales ${formatINR(dailySales)}`}
            >
              <div className="text-[10px] sm:text-xs text-white/90">Sales</div>
              <div className="text-sm sm:text-lg font-bold text-white">{formatINR(dailySales)}</div>
            </button>
            <button
              type="button"
              onClick={() => setPrinterSetupOpen(true)}
              className="p-1.5 sm:p-2.5 bg-white text-red-600 rounded-lg hover:bg-gray-100 transition-colors shadow-md min-h-[44px] min-w-[44px] flex items-center justify-center flex-shrink-0"
              title="Receipt printer"
              aria-label="Choose receipt printer"
            >
              <Bluetooth className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
            <button
              type="button"
              onClick={openServedOrdersModal}
              className="p-1.5 sm:p-2.5 bg-white text-red-600 rounded-lg hover:bg-gray-100 transition-colors shadow-md min-h-[44px] min-w-[44px] flex items-center justify-center flex-shrink-0"
              title="Served Orders History"
              aria-label="Served orders history"
            >
              <History className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
            <button
              type="button"
              onClick={openReportModal}
              className="p-1.5 sm:p-2.5 bg-white text-red-600 rounded-lg hover:bg-gray-100 transition-colors shadow-md min-h-[44px] min-w-[44px] flex items-center justify-center flex-shrink-0"
              title="Yesterday's sales"
              aria-label="Open yesterday's sales"
            >
              <BarChart3 className="w-4 h-4 sm:w-5 sm:h-5" />
            </button>
          </div>
        </div>
      </div>



      {/* Search and Filter Controls */}
      <div className="bg-white rounded-lg shadow-lg p-2 sm:p-4 mb-2 sm:mb-4">
        <div className="space-y-3">
          <div className="flex items-center gap-2 min-h-[44px]">
            {searchOpen ? (
              <div className="relative min-w-0 flex-1">
                <input
                  ref={searchInputRef}
                  type="text"
                  inputMode="search"
                  placeholder="Search dishes..."
                  value={searchTerm}
                  onChange={(e) => setSearchTerm(e.target.value)}
                  aria-label="Search menu items"
                  autoComplete="off"
                  className="w-full pl-3 pr-9 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent text-base text-black min-h-[44px]"
                />
                {searchTerm ? (
                  <button
                    type="button"
                    onClick={() => setSearchTerm('')}
                    className="absolute inset-y-0 right-0 pr-3 flex items-center text-gray-400 hover:text-gray-700"
                    aria-label="Clear search"
                  >
                    <X className="h-4 w-4" />
                  </button>
                ) : null}
              </div>
            ) : (
              <>
                <span className="min-w-0 flex-1 truncate text-xs sm:text-sm text-gray-600">
                  {selectedTable
                    ? `Dine-in · ${selectedTable.table_name || selectedTable.table_code}`
                    : 'Takeaway'}
                </span>
                {selectedTable ? (
                  <button
                    type="button"
                    onClick={handleTakeawaySelect}
                    className="shrink-0 text-red-700 font-medium hover:underline text-xs sm:text-sm min-h-[32px]"
                  >
                    Switch to takeaway
                  </button>
                ) : null}
              </>
            )}
            <button
              type="button"
              onClick={() => {
                if (searchOpen) {
                  setSearchOpen(false);
                  setSearchTerm('');
                } else {
                  setSearchOpen(true);
                }
              }}
              className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium transition-colors min-h-[44px] min-w-[44px] flex items-center justify-center ${
                searchOpen ? 'bg-red-600 text-white' : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
              title={searchOpen ? 'Close search' : 'Search menu'}
              aria-label={searchOpen ? 'Close search' : 'Search menu'}
              aria-pressed={searchOpen}
            >
              {searchOpen ? <X className="h-4 w-4" /> : <Search className="h-4 w-4" />}
            </button>
            <button
              type="button"
              onClick={() => setViewMode(viewMode === 'favorites' ? 'all' : 'favorites')}
              className={`shrink-0 px-3 py-2 rounded-lg text-sm font-medium transition-colors min-h-[44px] min-w-[44px] ${
                viewMode === 'favorites'
                  ? 'bg-red-600 text-white'
                  : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
              }`}
              title={viewMode === 'favorites' ? 'Show All Items' : 'Show Favorites'}
              aria-pressed={viewMode === 'favorites'}
              aria-label={viewMode === 'favorites' ? 'Show all items' : 'Show favorites'}
            >
              {viewMode === 'favorites' ? '⭐' : '☆'}
            </button>
          </div>

          {/* Category and View Mode Filters */}
          <div className="flex flex-wrap gap-2">
            {/* Category Filter */}
            <div
              className="flex overflow-x-auto gap-1 pb-1 scrollbar-hide touch-pan-x overscroll-x-contain"
              data-no-page-swipe="true"
              onTouchStart={(e) => e.stopPropagation()}
              onTouchMove={(e) => e.stopPropagation()}
              onTouchEnd={(e) => e.stopPropagation()}
            >
              {['All', ...Array.from(new Set(menuItems.map(item => item.category).filter(cat => cat !== 'All')))].map(category => (
                <button
                  key={category}
                  onClick={() => setSelectedCategory(category === 'All' ? null : category)}
                  className={`px-3 py-1 rounded-full text-xs font-medium transition-colors whitespace-nowrap flex-shrink-0 ${
                    (selectedCategory === category || (category === 'All' && selectedCategory === null))
                      ? 'bg-red-600 text-white'
                      : 'bg-gray-100 text-gray-700 hover:bg-gray-200'
                  }`}
                >
                  {category}
                </button>
              ))}
            </div>


          </div>
        </div>
      </div>

      {/* Edit Order Modal */}
      {editingOrder && (
        <div className="fixed inset-0 bg-black bg-opacity-60 backdrop-blur-sm flex items-center justify-center p-2 sm:p-4 z-[100] transition-opacity duration-300">
          <div className="bg-white rounded-xl max-w-sm sm:max-w-md w-full max-h-[90vh] shadow-2xl border border-gray-200 transform transition-all duration-300 scale-100 flex flex-col overflow-hidden">

            {/* Header */}
            <div className="flex justify-between items-center flex-shrink-0 px-4 sm:px-6 pt-4 sm:pt-6 pb-4 border-b border-gray-200">
              <div>
                <h2 className="text-2xl font-bold text-gray-900 bg-gradient-to-r from-red-600 to-red-800 bg-clip-text text-transparent">
                  Edit Order #{editingOrder.order_number.toString().padStart(3, '0')}
                </h2>
                <p className="text-sm text-gray-600 mt-1">Modify items and quantities</p>
                {editingOrder.order_type === 'DINE_IN' && editingOrder.table_code && (
                  <p className="text-sm text-blue-600 font-medium mt-1">Table: {editingOrder.table_code}</p>
                )}
                {editingOrder.customer_name ? (
                  <p className="text-sm text-gray-700 mt-1">
                    {editingOrder.customer_name}
                    {editingOrder.customer_phone ? ` · ${editingOrder.customer_phone}` : ''}
                  </p>
                ) : null}
              </div>
              <button
                type="button"
                onClick={cancelEdit}
                className="p-2 text-gray-500 hover:text-gray-700 hover:bg-gray-100 rounded-full transition-colors duration-200 min-h-[44px] min-w-[44px] flex items-center justify-center"
                title="Cancel"
              >
                <X className="w-6 h-6" />
              </button>
            </div>

            <div className="flex-1 min-h-0 overflow-y-auto px-4 sm:px-6 py-4">
            
            {/* Current Items Section */}
            <div className="mb-6">
              <h3 className="font-semibold text-gray-900 mb-4 text-lg flex items-center gap-2">
                <div className="w-2 h-2 bg-red-500 rounded-full"></div>
                Current Items
              </h3>
              <div className="space-y-3">
                {editingOrder.items.map(item => (
                  <div key={item.id} className="flex justify-between items-center p-4 bg-gray-50 rounded-lg border border-gray-200 hover:bg-gray-100 transition-colors duration-200">
                    <div className="flex-1 min-w-0">
                      <span className="text-gray-900 font-medium text-sm block truncate">{item.name}</span>
                      <span className="text-gray-600 text-xs">₹{item.price} each</span>
                    </div>
                    <div className="flex items-center gap-3">
                      <div className="flex items-center gap-2 bg-white rounded-full p-1 shadow-sm">
                        <button
                          onClick={() => updateEditingOrderItem(item.id, item.quantity - 1)}
                          className="w-8 h-8 bg-gray-100 text-gray-700 rounded-full flex items-center justify-center hover:bg-gray-200 transition-colors duration-200 font-semibold text-lg"
                          title="Decrease quantity"
                        >
                          -
                        </button>
                        <span className="w-8 text-center font-bold text-gray-900 text-sm">{item.quantity}</span>
                        <button
                          onClick={() => updateEditingOrderItem(item.id, item.quantity + 1)}
                          className="w-8 h-8 bg-red-100 text-red-700 rounded-full flex items-center justify-center hover:bg-red-200 transition-colors duration-200 font-semibold text-lg"
                          title="Increase quantity"
                        >
                          +
                        </button>
                      </div>
                      <button
                        onClick={() => updateEditingOrderItem(item.id, 0)}
                        className="p-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-full transition-colors duration-200"
                        title="Remove item"
                      >
                        <Trash2 className="w-5 h-5" />
                      </button>
                    </div>
                  </div>
                ))}
              </div>
            </div>

            {/* Add Items Section */}
            <div className="mb-6">
              <h3 className="font-semibold text-gray-900 mb-4 text-lg flex items-center gap-2">
                <div className="w-2 h-2 bg-green-500 rounded-full"></div>
                Add Items
              </h3>

              {/* Search Bar for Edit Order */}
              <div className="relative mb-4">
                <input
                  type="text"
                  placeholder="Search menu items..."
                  value={editOrderSearchTerm}
                  onChange={(e) => setEditOrderSearchTerm(e.target.value)}
                  className="w-full pl-10 pr-4 py-2 border border-gray-300 rounded-lg focus:ring-2 focus:ring-red-500 focus:border-transparent text-base text-black min-h-[44px]"
                />
                <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                  <svg className="h-4 w-4 text-gray-400" fill="none" stroke="currentColor" viewBox="0 0 24 24">
                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M21 21l-6-6m2-5a7 7 0 11-14 0 7 7 0 0114 0z" />
                  </svg>
                </div>
              </div>

              <div className="grid grid-cols-2 gap-3">
                {menuItems
                  .filter(item => item.name.toLowerCase().includes(editOrderSearchTerm.toLowerCase()))
                  .map(item => (
                    <button
                      key={item.id}
                      onClick={() => addItemToEditingOrder(item)}
                      className="bg-gradient-to-r from-red-500 to-red-700 hover:from-red-600 hover:to-red-800 text-white p-3 rounded-lg font-medium text-sm transition-all duration-200 transform hover:scale-105 shadow-md hover:shadow-lg"
                    >
                      <div className="font-semibold text-xs leading-tight">{item.name}</div>
                      <div className="text-xs opacity-90 mt-1">₹{item.price}</div>
                    </button>
                  ))}
              </div>

              {/* No items found message */}
              {menuItems.filter(item => item.name.toLowerCase().includes(editOrderSearchTerm.toLowerCase())).length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <div className="text-sm">No menu items found</div>
                  <div className="text-xs mt-1">Try adjusting your search</div>
                </div>
              )}
            </div>
            </div>

            {/* Total and Action Buttons — fixed bar */}
            <div className="flex-shrink-0 border-t border-gray-200 bg-white px-4 sm:px-6 py-3 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
              {editingOrder.items.length === 0 && (
                <p className="text-xs text-yellow-800 bg-yellow-50 border-l-4 border-yellow-400 px-2 py-1.5 rounded mb-2">
                  This order will be deleted if you save without any items.
                </p>
              )}
              <div className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="text-xs text-gray-500">
                    {editingOrder.items.reduce((n, item) => n + item.quantity, 0)} items
                  </div>
                  <div className="text-lg font-bold text-gray-900">{formatINR(editingOrder.total)}</div>
                </div>
                <button
                  type="button"
                  onClick={cancelEdit}
                  className="min-h-[44px] px-3 py-2 bg-gray-200 text-gray-700 rounded-lg font-medium hover:bg-gray-300 border border-gray-300 text-sm"
                >
                  Cancel
                </button>
                <button
                  type="button"
                  onClick={saveEditedOrder}
                  className="min-h-[44px] px-4 py-2 bg-gradient-to-r from-red-600 to-red-800 text-white rounded-lg font-medium hover:from-red-700 hover:to-red-900 shadow-md flex items-center gap-1.5 justify-center text-sm"
                >
                  <Save className="w-4 h-4" />
                  Save
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Current Order */}
      {buildingOrder.length > 0 && (
        <div className="bg-white rounded-lg shadow-lg p-3 sm:p-4 mb-3 sm:mb-4">
          <h2 className="font-semibold text-gray-800 text-base sm:text-lg mb-3 sm:mb-4 flex items-center gap-2">
            <div className="w-2 h-2 bg-green-500 rounded-full"></div>
            Current Order
            {selectedTable ? (
              <span className="text-xs sm:text-sm text-blue-800 font-medium ml-2">
                - {selectedTable.table_name} ({selectedTable.capacity} seats)
              </span>
            ) : (
              <span className="text-xs sm:text-sm text-green-600 font-medium ml-2">
                - Takeaway Order
              </span>
            )}
          </h2>

          <div className="space-y-2 sm:space-y-3 mb-3 sm:mb-4">
            {buildingOrder.map(item => (
              <div key={item.id} className="flex justify-between items-center p-2 sm:p-3 bg-gray-50 rounded-lg border border-gray-200">
                <div className="flex-1 min-w-0">
                  <span className="text-gray-900 font-medium text-xs sm:text-sm block truncate">{item.name}</span>
                  <span className="text-gray-600 text-xs">₹{item.price} each</span>
                </div>
                <div className="flex items-center gap-2 sm:gap-3">
                  <div className="flex items-center gap-1 sm:gap-2 bg-white rounded-full p-1 shadow-sm">
                    <button
                      onClick={() => updateBuildingOrderItemQuantity(item.id, item.quantity - 1)}
                      className="w-6 h-6 sm:w-8 sm:h-8 bg-gray-100 text-gray-700 rounded-full flex items-center justify-center hover:bg-gray-200 transition-colors duration-200 font-semibold text-sm sm:text-lg"
                      title="Decrease quantity"
                    >
                      -
                    </button>
                    <span className="w-6 sm:w-8 text-center font-bold text-gray-900 text-xs sm:text-sm">{item.quantity}</span>
                    <button
                      onClick={() => updateBuildingOrderItemQuantity(item.id, item.quantity + 1)}
                      className="w-6 h-6 sm:w-8 sm:h-8 bg-red-100 text-red-700 rounded-full flex items-center justify-center hover:bg-red-200 transition-colors duration-200 font-semibold text-sm sm:text-lg"
                      title="Increase quantity"
                    >
                      +
                    </button>
                  </div>
                  <button
                    onClick={() => removeItemFromBuildingOrder(item.id)}
                    className="p-1.5 sm:p-2 text-red-500 hover:text-red-700 hover:bg-red-50 rounded-full transition-colors duration-200"
                    title="Remove item"
                  >
                    <Trash2 className="w-4 h-4 sm:w-5 sm:h-5" />
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="border-t border-gray-200 pt-3 sm:pt-4">
            <div className="flex flex-row justify-between items-center gap-3 mb-3">
              <button
                type="button"
                onClick={placeOrder}
                className="hidden md:block w-full sm:w-auto px-3 sm:px-4 py-2 sm:py-2 bg-gradient-to-r from-green-600 to-green-800 text-white rounded-lg font-medium hover:from-green-700 hover:to-green-900 transition-all duration-200 shadow-md hover:shadow-lg text-sm sm:text-base min-h-[44px]"
              >
                Place Order
              </button>
              <div>
                <div className="text-xs sm:text-sm text-gray-600">Order Total</div>
                <div className="text-lg sm:text-xl font-bold text-gray-900">
                  {formatINR(buildingTotal)}
                </div>
              </div>
            </div>
          </div>
        </div>
      )}

      {buildingOrder.length > 0 && (
        <div className="md:hidden fixed bottom-0 left-0 right-0 z-30 border-t border-gray-200 bg-white px-3 py-2 shadow-[0_-4px_12px_rgba(0,0,0,0.08)]">
          <div className="flex items-center gap-3">
            <div className="min-w-0 flex-1">
              <div className="text-xs text-gray-500 truncate">
                {buildingOrder.reduce((n, item) => n + item.quantity, 0)} items
                {selectedTable ? ` · ${selectedTable.table_code}` : ' · Takeaway'}
              </div>
              <div className="text-base font-bold text-gray-900">{formatINR(buildingTotal)}</div>
            </div>
            <button
              type="button"
              onClick={placeOrder}
              className="min-h-[44px] flex-shrink-0 rounded-lg bg-gradient-to-r from-green-600 to-green-800 px-4 py-2 text-sm font-medium text-white shadow-md"
            >
              Place Order
            </button>
          </div>
        </div>
      )}

      {/* Menu Grid */}
      <div className="bg-white rounded-lg shadow-lg p-2 sm:p-4 mb-3 sm:mb-4">
        {/* Filtered Menu Items */}
        <div className="grid grid-cols-2 sm:grid-cols-3 md:grid-cols-4 lg:grid-cols-5 xl:grid-cols-6 gap-1 sm:gap-1.5 md:gap-2">
          {filteredMenuItems.map(item => {
              const inCartQty = buildingQtyById.get(item.id) || 0;
              const isPopular = popularNameSet.has(item.name.toLowerCase());
              return photoMenu ? (
                <WaiterPhotoDishCard
                  key={item.id}
                  item={item}
                  photoSrc={dishPhotos[item.id]}
                  inCartQty={inCartQty}
                  isPopular={isPopular}
                  isFavorite={favorites.includes(item.id)}
                  canOrder={Boolean(selectedTable || selectedOrderType === 'TAKEAWAY')}
                  onAdd={() => addToOrder(item, 1)}
                  onHold={() => setStockoutItem(item)}
                  onToggleFavorite={() =>
                    setFavorites((prev) =>
                      prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]
                    )
                  }
                />
              ) : (
                <WaiterTextDishCard
                  key={item.id}
                  item={item}
                  inCartQty={inCartQty}
                  isPopular={isPopular}
                  isFavorite={favorites.includes(item.id)}
                  canOrder={Boolean(selectedTable || selectedOrderType === 'TAKEAWAY')}
                  onAdd={() => addToOrder(item, 1)}
                  onHold={() => setStockoutItem(item)}
                  onToggleFavorite={() =>
                    setFavorites((prev) =>
                      prev.includes(item.id) ? prev.filter((id) => id !== item.id) : [...prev, item.id]
                    )
                  }
                />
              );
            })}
        </div>

        {filteredMenuItems.length === 0 && (
          <div className="text-center py-8 text-gray-500">
            <div className="text-sm">No menu items found</div>
            <div className="text-xs mt-1">Try adjusting your search or filters</div>
            <button
              type="button"
              onClick={() => {
                setSearchTerm('');
                setSearchOpen(false);
                setSelectedCategory(null);
                setViewMode('all');
              }}
              className="mt-3 text-sm font-medium text-red-700 hover:underline min-h-[44px]"
            >
              Clear filters
            </button>
          </div>
        )}
      </div>



      {/* Analytics Chart */}
      {showAnalytics && (
        <div className="bg-white rounded-lg shadow-lg p-4 mb-4">
          <div className="flex justify-between items-center mb-4">
            {/* <h2 className="font-semibold text-gray-800 text-lg flex items-center gap-2">
              <TrendingUp className="w-6 h-6 text-blue-600" />
              Order Analytics
            </h2> */}
            <button
              onClick={() => setShowAnalytics(false)}
              className="p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded-full transition-colors"
              title="Close Analytics"
            >
              <X className="w-5 h-5" />
            </button>
          </div>
          {/* <OrderAnalyticsChart /> */}
        </div>
      )}

      {stockoutItem && (
        <div className="fixed inset-0 bg-black/50 flex items-center justify-center p-4 z-[80]">
          <div className="bg-white rounded-lg p-5 max-w-sm w-full shadow-xl">
            <h2 className="text-lg font-bold text-gray-900">
              {stockoutItem.out_of_stock ? 'Mark back in stock?' : 'Out of stock for today?'}
            </h2>
            <p className="mt-2 text-sm text-gray-600">
              {stockoutItem.out_of_stock
                ? `${stockoutItem.name} can be ordered again by guests and waiters.`
                : `${stockoutItem.name} will stay on the menu as sold out until you restock it or tomorrow.`}
            </p>
            <div className="mt-4 flex gap-2">
              <button
                type="button"
                onClick={() => setStockoutItem(null)}
                className="flex-1 min-h-[44px] rounded-lg border border-gray-300 text-sm font-medium text-gray-700"
                disabled={stockoutBusy}
              >
                Cancel
              </button>
              <button
                type="button"
                onClick={confirmStockoutToggle}
                className="flex-1 min-h-[44px] rounded-lg bg-red-700 text-sm font-medium text-white disabled:opacity-60"
                disabled={stockoutBusy}
              >
                {stockoutBusy ? 'Saving…' : stockoutItem.out_of_stock ? 'Restock' : 'Mark sold out'}
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Sales Report Modal */}
      {isReportModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-6 max-w-md w-full max-h-[80vh] overflow-y-auto shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <div>
                <h2 className="text-xl font-bold text-gray-900">Yesterday’s sales</h2>
                {startDate ? (
                  <p className="text-sm text-gray-500">
                    {new Date(`${startDate}T12:00:00`).toLocaleDateString('en-IN', {
                      day: 'numeric',
                      month: 'short',
                      year: 'numeric',
                    })}
                  </p>
                ) : null}
              </div>
              <button
                onClick={closeReportModal}
                className="p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            {reportLoading ? (
              <p className="py-8 text-center text-sm text-gray-500">Loading yesterday’s sales…</p>
            ) : null}

            {salesReport && (
              <div className="border-t border-gray-200 pt-4">
                <h3 className="font-semibold text-gray-900 mb-3">Report Results:</h3>
                
                <div className="space-y-3">
                  <div className="bg-green-50 p-3 rounded">
                    <div className="text-sm text-green-800">Total Revenue</div>
                    <div className="text-lg font-bold text-green-900">{formatINR(salesReport.total_revenue || 0)}</div>
                  </div>
                  
                  <div className="bg-red-50 p-3 rounded">
                    <div className="text-sm text-red-800">Total Orders</div>
                    <div className="text-lg font-bold text-red-900">{salesReport.total_orders || 0}</div>
                  </div>
                  
                  {salesReport.top_items && salesReport.top_items.length > 0 && (
                    <div>
                      <h4 className="font-medium text-gray-900 mb-2">Top Selling Items:</h4>
                      <div className="space-y-2">
                        {salesReport.top_items.slice(0, 5).map((item: any, index: number) => (
                          <div key={index} className="flex justify-between items-center p-2 bg-orange-50 rounded">
                            <span className="break-words min-w-0 flex-1 text-sm text-orange-800">{item.name}</span>
                            <span className="ml-2 font-medium text-orange-900">{item.quantity} sold</span>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )}
          </div>
        </div>
      )}

      {/* Professional Bill Popup */}
      {viewingOrder && (
        <div id="print-bill-overlay" className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[60] print:block print:bg-white print:p-0 print:m-0">
          <div id="print-bill-content" className="bg-white rounded-lg max-w-sm w-full max-h-[90vh] overflow-y-auto shadow-2xl border-2 border-gray-300 print:shadow-none print:border-none print:max-w-none print:w-full print:max-h-none print:overflow-visible print:p-0 print:m-0 print:min-h-screen print:flex print:flex-col">
            {/* Logo at Top */}
            <div className="flex justify-center py-2 px-4 border-b-2 border-gray-300 print:border-b print:border-black print:py-1 print:px-2">
              <img src="/adda.png" alt="Restaurant Logo" className="w-12 h-12 print:w-16 print:h-16" />
            </div>

            {/* Bill Content */}
            <div className="p-3 print:p-1">
              {/* Restaurant Header */}
              <div className="text-center mb-2 print:mb-1">
                <h1 className="text-base font-bold text-gray-900 print:text-black print:text-lg">Adda Cafe</h1>
              </div>

              {/* Order Header */}
              <div className="text-center mb-2 print:mb-1">
                <div className="text-xs text-gray-600 print:text-black">Order #{viewingOrder.order_number.toString().padStart(3, '0')}</div>
                <div className="text-xs text-gray-500 print:text-black">{new Date().toLocaleDateString()} {new Date().toLocaleTimeString()}</div>
                {viewingOrder.order_type === 'DINE_IN' && viewingOrder.table_code && (
                  <div className="text-xs text-gray-500 print:text-black">Table: {viewingOrder.table_code}</div>
                )}
                {viewingOrder.order_type === 'TAKEAWAY' && (
                  <div className="text-xs text-gray-500 print:text-black">Takeaway</div>
                )}
                {viewingOrder.customer_name ? (
                  <div className="text-xs text-gray-700 print:text-black font-medium">
                    {viewingOrder.customer_name}
                    {viewingOrder.customer_phone ? ` · ${viewingOrder.customer_phone}` : ''}
                  </div>
                ) : null}
              </div>

              {/* Items List */}
              <div className="border-t border-b border-gray-300 py-1 mb-2 print:border-black print:py-0.5 print:mb-1">
                <div className="space-y-0.5 print:space-y-0">
                  {viewingOrder.items.map(item => (
                    <div key={item.id} className="flex justify-between items-center py-0.5 print:py-0">
                      <div className="flex-1">
                        <span className="text-gray-900 font-medium print:text-black text-xs">{item.quantity}x {item.name}</span>
                      </div>
                      <div className="text-right">
                        <span className="text-gray-900 font-medium print:text-black text-xs">₹{item.price * item.quantity}</span>
                      </div>
                    </div>
                  ))}
                </div>
              </div>

              {/* Total */}
              <div className="border-t-2 border-gray-300 pt-1 mb-2 print:border-black print:pt-0.5 print:mb-1">
                <div className="flex justify-between items-center">
                  <span className="text-base font-bold text-gray-900 print:text-black print:text-lg">TOTAL</span>
                  <span className="text-base font-bold text-red-900 print:text-black print:text-lg">₹{viewingOrder.total}</span>
                </div>
              </div>

              {/* Google Review QR Code */}
              <GoogleReviewQR size={60} tableCode={viewingOrder.table_code} />

              {/* Footer */}
              <div className="text-center text-xs text-gray-500 print:text-black mb-2 print:mb-1">
                <p>Thank you for your business!</p>
                <p>Please visit again</p>
              </div>

              {/* Action Buttons at Bottom */}
              {printNotice ? (
                <p className={`text-center text-xs print:hidden mb-1 ${printNotice === 'Printed' ? 'text-emerald-700' : 'text-red-700'}`}>
                  {printNotice}
                </p>
              ) : null}
              <div className="flex gap-3 justify-center print:hidden mt-2 flex-wrap">
                {viewingOrder.status === 'pending' ? (
                  <button
                    onClick={() => {
                      void acceptQrOrder(viewingOrder);
                      closeOrderPopup();
                    }}
                    className="flex-1 px-4 py-2 bg-amber-500 text-white rounded-lg font-medium"
                  >
                    Accept QR order
                  </button>
                ) : null}
                {viewingOrder.order_type === 'DINE_IN' && viewingOrder.table_code ? (
                  <button
                    onClick={() => {
                      const table = tables.find((item) => item.table_code === viewingOrder.table_code);
                      if (table) void updateTableQrSession(table, 'close');
                    }}
                    className="px-3 py-2 bg-gray-800 text-white rounded-lg font-medium text-sm"
                  >
                    Stop QR
                  </button>
                ) : null}
<button
  onClick={() => void handlePosPrint(viewingOrder)}
  disabled={printBusy}
  className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-medium disabled:opacity-50"
>
  {printBusy ? 'Printing…' : 'Print'}
</button>

                <button
                  onClick={() => editOrder(viewingOrder)}
                  className="px-3 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors text-sm"
                  title="Edit Order"
                >
                  Edit
                </button>

{/* <button
  onClick={() => {
    const baseUrl =
      process.env.NEXT_PUBLIC_PRODUCTION_DOMAIN ??
      window.location.origin;
    window.location.href =
      `my.bluetoothprint.scheme://${baseUrl}/api/print/order/${viewingOrder.id}`;
    openPaymentModeModal(viewingOrder);
  }}
  className="flex-1 px-4 py-2 bg-green-600 text-white rounded-lg font-medium"
>
  🖨️ Print
</button> */}

                {/* <button
                  onClick={() => printBill(viewingOrder)}
                  className="flex-1 px-4 py-2 bg-blue-600 text-white rounded-lg font-medium hover:bg-blue-700 transition-colors"
                  title="Print Bill (Browser)"
                >
                  🖨️ Browser Print
                </button> */}
                <button
                  onClick={closeOrderPopup}
                  className="flex-1 px-4 py-2 bg-gray-600 text-white rounded-lg font-medium hover:bg-gray-700 transition-colors"
                  title="Close"
                >
                  Close
                </button>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Confirmation Modal */}
      {isConfirmModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[60]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-xl font-bold text-gray-900">Confirm Deletion</h2>
              <button
                onClick={closeConfirmModal}
                className="p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mb-6">
              <p className="text-gray-700">
                Are you sure you want to delete this order? This action cannot be undone.
              </p>
            </div>

            <div className="flex gap-2 sm:gap-3 justify-end flex-col sm:flex-row">
              <button
                onClick={closeConfirmModal}
                className="px-4 py-2 bg-gray-300 text-gray-700 rounded-lg font-medium hover:bg-gray-400 transition-colors text-sm sm:text-base"
              >
                Cancel
              </button>
              <button
                onClick={handleConfirmDelete}
                className="px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors text-sm sm:text-base"
              >
                Delete Order
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Served Orders Modal */}
      {isServedOrdersModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-4 sm:p-6 max-w-md w-full max-h-[80vh] overflow-y-auto shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg sm:text-xl font-bold text-gray-900">Recent Served Orders</h2>
              <button
                onClick={closeServedOrdersModal}
                className="p-1.5 sm:p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded"
                title="Close"
              >
                <X className="w-4 h-4 sm:w-5 sm:h-5" />
              </button>
            </div>

            {loadingServedOrders ? (
              <div className="text-center py-8">
                <div className="animate-spin rounded-full h-6 w-6 sm:h-8 sm:w-8 border-b-2 border-red-600 mx-auto mb-3 sm:mb-4"></div>
                <div className="text-sm sm:text-base text-gray-600">Loading served orders...</div>
              </div>
            ) : servedOrders.length === 0 ? (
              <div className="text-center py-8 text-gray-500">
                <History className="w-10 h-10 sm:w-12 sm:h-12 mx-auto mb-3 sm:mb-4 opacity-50" />
                <div className="text-sm sm:text-base">No served orders yet</div>
                <div className="text-xs sm:text-sm mt-1 sm:mt-2">Orders that have been served will appear here</div>
              </div>
            ) : (
              <div className="space-y-2 sm:space-y-3">
                {servedOrders.map(order => (
                  <div key={order.id} className="p-3 sm:p-4 bg-green-50 rounded-lg border border-green-200">
                    <div className="flex justify-between items-start mb-2">
                      <div className="flex items-center gap-1.5 sm:gap-2">
                        <span className="font-bold text-green-900 text-sm sm:text-base">#{order.order_number.toString().padStart(3, '0')}</span>
                        <span className="px-1.5 py-0.5 sm:px-2 sm:py-1 bg-green-200 text-green-900 rounded-full text-xs font-semibold">
                          served
                        </span>
                      </div>
                      <div className="text-right">
                        <div className="font-bold text-green-900 text-sm sm:text-base">₹{order.total}</div>
                      </div>
                    </div>

                    <div className="text-xs sm:text-sm text-green-800">
                      {order.items.map(item => (
                        <div key={item.id} className="flex justify-between py-0.5 sm:py-1">
                          <span className="break-words min-w-0 flex-1">{item.quantity}x {item.name}</span>
                          <span className="ml-2">₹{item.price * item.quantity}</span>
                        </div>
                      ))}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}

      {/* Payment Mode Selection Modal */}
      {isPaymentModeModalOpen && orderToServe && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-[60]">
          <div className="bg-white rounded-lg p-6 max-w-md w-full shadow-xl max-h-[90vh] overflow-y-auto">
            <div className="flex justify-between items-center mb-6">
              <h2 className="text-xl font-bold text-gray-900">Select Payment Mode</h2>
              <button
                onClick={closePaymentModeModal}
                className="p-2 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded"
                title="Close"
              >
                <X className="w-5 h-5" />
              </button>
            </div>

            <div className="mb-6">
              <div className="bg-gray-50 p-4 rounded-lg mb-4">
                <div className="flex justify-between items-center mb-2">
                  <span className="font-semibold text-gray-900">Order #{orderToServe.order_number}</span>
                  <span className="font-bold text-lg text-red-900">₹{payPreview?.net ?? orderToServe.total}</span>
                </div>
                <div className="text-sm text-gray-600">
                  {orderToServe.items.map(item => (
                    <div key={item.id} className="flex justify-between">
                      <span>{item.quantity}x {item.name}</span>
                      <span>₹{item.price * item.quantity}</span>
                    </div>
                  ))}
                </div>
                {payPreview ? (
                  <div className="mt-3 border-t border-gray-200 pt-2 text-sm">
                    <div className="flex justify-between text-gray-600">
                      <span>Gross</span>
                      <span>₹{payPreview.gross}</span>
                    </div>
                    <div className="flex justify-between text-green-700">
                      <span>Discount{payPreview.name ? ` (${payPreview.name})` : ''}</span>
                      <span>-₹{payPreview.discount}</span>
                    </div>
                    <div className="flex justify-between font-bold text-gray-900">
                      <span>Net</span>
                      <span>₹{payPreview.net}</span>
                    </div>
                  </div>
                ) : null}
              </div>

              <div className="mb-4 space-y-2">
                <label className="block text-sm font-medium text-gray-800">
                  Customer mobile
                  <input
                    inputMode="numeric"
                    value={payPhone}
                    onChange={(e) => {
                      setPayPhone(e.target.value);
                      setPayPreview(null);
                    }}
                    className="mt-1 w-full rounded-lg border border-gray-200 px-3 py-2 text-base"
                    placeholder="10-digit number"
                  />
                </label>
                <label className="block text-sm font-medium text-gray-800">
                  Offer code (optional)
                  <div className="mt-1 flex gap-2">
                    <input
                      value={payOfferCode}
                      onChange={(e) => {
                        setPayOfferCode(e.target.value.toUpperCase());
                        setPayPreview(null);
                      }}
                      className="min-w-0 flex-1 rounded-lg border border-gray-200 px-3 py-2 text-base"
                      placeholder="BDAY10"
                    />
                    <button
                      type="button"
                      disabled={payBusy || !payOfferCode.trim()}
                      onClick={() => void previewPayOffer()}
                      className="rounded-lg bg-gray-900 px-3 py-2 text-sm font-semibold text-white disabled:opacity-50"
                    >
                      Apply
                    </button>
                  </div>
                </label>
                {payError ? <p className="text-sm text-red-700">{payError}</p> : null}
              </div>

              <p className="text-gray-700 mb-4">
                How did the customer pay for this order?
              </p>
            </div>

            <div className="flex gap-3">
              <button
                disabled={payBusy}
                onClick={() => handlePaymentModeSelection('cash')}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white py-3 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                💵 Cash
              </button>
              <button
                disabled={payBusy}
                onClick={() => handlePaymentModeSelection('online')}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white py-3 px-4 rounded-lg font-medium transition-colors flex items-center justify-center gap-2 disabled:opacity-50"
              >
                📱 Online
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Payment Revenue Modal */}
      {isPaymentRevenueModalOpen && (
        <div className="fixed inset-0 bg-black bg-opacity-50 flex items-center justify-center p-4 z-50">
          <div className="bg-white rounded-lg p-4 max-w-sm w-full max-h-[70vh] overflow-y-auto shadow-xl">
            <div className="flex justify-between items-center mb-4">
              <h2 className="text-lg font-bold text-gray-900">Today's Payment Breakdown</h2>
              <button
                onClick={closePaymentRevenueModal}
                className="p-1 text-gray-600 hover:text-gray-800 hover:bg-gray-100 rounded"
                title="Close"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-3">
              {/* Total Revenue */}
              <div className="bg-gradient-to-r from-green-50 to-emerald-50 p-3 rounded-lg border border-green-200">
                <div className="flex items-center justify-between">
                  <div>
                    <div className="text-xs text-green-700 font-medium">Total Revenue</div>
                    <div className="text-xl font-bold text-green-900">{formatINR(salesData.total_revenue)}</div>
                  </div>
                  <div className="text-2xl">💰</div>
                </div>
              </div>

              {/* Cash & Online Payments in one row */}
              <div className="grid grid-cols-2 gap-2">
                <div className="bg-gradient-to-r from-yellow-50 to-amber-50 p-3 rounded-lg border border-yellow-200">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-xs text-yellow-700 font-medium">Cash</div>
                    <div className="text-lg">💵</div>
                  </div>
                  <div className="text-sm font-bold text-yellow-900">{formatINR(salesData.payment_breakdown.cash.revenue)}</div>
                  <div className="text-xs text-yellow-600">{salesData.payment_breakdown.cash.orders} orders</div>
                </div>

                <div className="bg-gradient-to-r from-blue-50 to-indigo-50 p-3 rounded-lg border border-blue-200">
                  <div className="flex items-center justify-between mb-1">
                    <div className="text-xs text-blue-700 font-medium">Online</div>
                    <div className="text-lg">📱</div>
                  </div>
                  <div className="text-sm font-bold text-blue-900">{formatINR(salesData.payment_breakdown.online.revenue)}</div>
                  <div className="text-xs text-blue-600">{salesData.payment_breakdown.online.orders} orders</div>
                </div>
              </div>

              {/* Payment Distribution - Compact */}
              <div className="bg-gray-50 p-3 rounded-lg">
                <h3 className="font-semibold text-gray-900 mb-2 text-sm">Payment Distribution</h3>
                <div className="space-y-2">
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-600">Cash</span>
                    <span className="text-xs font-medium text-gray-900">
                      {salesData.total_revenue > 0
                        ? Math.round((salesData.payment_breakdown.cash.revenue / salesData.total_revenue) * 100)
                        : 0}%
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div
                      className="bg-yellow-500 h-1.5 rounded-full"
                      style={{
                        width: `${salesData.total_revenue > 0
                          ? (salesData.payment_breakdown.cash.revenue / salesData.total_revenue) * 100
                          : 0}%`
                      }}
                    ></div>
                  </div>
                  <div className="flex justify-between items-center">
                    <span className="text-xs text-gray-600">Online</span>
                    <span className="text-xs font-medium text-gray-900">
                      {salesData.total_revenue > 0
                        ? Math.round((salesData.payment_breakdown.online.revenue / salesData.total_revenue) * 100)
                        : 0}%
                    </span>
                  </div>
                  <div className="w-full bg-gray-200 rounded-full h-1.5">
                    <div
                      className="bg-blue-500 h-1.5 rounded-full"
                      style={{
                        width: `${salesData.total_revenue > 0
                          ? (salesData.payment_breakdown.online.revenue / salesData.total_revenue) * 100
                          : 0}%`
                      }}
                    ></div>
                  </div>
                </div>
              </div>
            </div>

            <div className="mt-4 pt-3 border-t border-gray-200">
              <button
                onClick={closePaymentRevenueModal}
                className="w-full px-4 py-2 bg-red-600 text-white rounded-lg font-medium hover:bg-red-700 transition-colors text-sm"
              >
                Close
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pending Orders Sidebar */}
      <PendingOrdersSidebar
        isOpen={pendingSidebarOpen}
        onClose={() => setPendingSidebarOpen(false)}
        orders={orders}
        selectedTableFilter={selectedTableFilter}
        setSelectedTableFilter={setSelectedTableFilter}
        tables={tables}
        isDropdownOpen={isDropdownOpen}
        setIsDropdownOpen={setIsDropdownOpen}
        onOrderClick={handleOrderClick}
        onEditOrder={editOrder}
        onServeOrder={openPaymentModeModal}
        onAcceptOrder={acceptQrOrder}
        onDeleteOrder={openConfirmModal}
        onRemoveItem={removeItemFromOrder}
      />

      {/* Animated Sidebar */}
      {sidebarOpen && (
        <>
          {/* Dark overlay */}
          <div
            className="fixed inset-0 bg-black bg-opacity-50 z-40"
            onClick={() => setSidebarOpen(false)}
          />

          {/* Sidebar */}
          <div className={`fixed left-0 top-0 h-full w-full sm:w-80 bg-white shadow-lg z-50 transform transition-transform duration-300 ease-in-out flex flex-col ${
            sidebarOpen ? 'translate-x-0' : '-translate-x-full'
          }`}>
            {/* Sidebar Header */}
            <div className="bg-gradient-to-r from-red-600 to-red-700 p-4">
              <div className="flex justify-between items-center">
                <h2 className="text-white font-semibold text-lg">Tables & Orders</h2>
                <button
                  onClick={() => setSidebarOpen(false)}
                  className="text-white hover:bg-white/20 rounded-full p-2 transition-colors"
                >
                  <X className="w-5 h-5" />
                </button>
              </div>
            </div>

            {/* Takeaway Section */}
            <div className="p-4 border-b border-gray-200">
              <button
                onClick={() => {
                  setSelectedOrderType('TAKEAWAY');
                  setSelectedTable(null);
                  setBuildingOrder([]);
                  setSidebarOpen(false);
                }}
                className="w-full bg-gradient-to-r from-green-500 to-green-600 hover:from-green-600 hover:to-green-700 text-white rounded-xl p-4 flex items-center gap-3 transition-all duration-200 shadow-md hover:shadow-lg"
              >
                <Package className="w-6 h-6" />
                <span className="font-semibold">Takeaway Order</span>
              </button>
            </div>

            {/* Table Grid */}
            <div className="flex-1 overflow-y-auto p-4">
              <div className="grid grid-cols-2 gap-3">
                {tables
                  .filter(table => table.is_active)
                  .map(table => {
                    const isSelected = selectedTable?.table_code === table.table_code;
                    const hasPendingOrder = orders.some(order =>
                      order.table_code === table.table_code && order.status !== 'served'
                    );

                    return (
                      <div
                        key={table.id}
                        className={`relative p-4 rounded-xl border-2 transition-all duration-200 ${
                          hasPendingOrder
                            ? 'bg-red-100 border-red-500'
                            : isSelected
                            ? 'bg-blue-100 border-blue-500 shadow-md'
                            : 'bg-white border-gray-300 shadow-sm'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={() => {
                            if (hasPendingOrder) {
                              const pendingOrder = orders.find(order =>
                                order.table_code === table.table_code && order.status !== 'served'
                              );
                              if (pendingOrder) {
                                handleOrderClick(pendingOrder);
                                setSidebarOpen(false);
                              }
                            } else {
                              setSelectedTable(table);
                              setSelectedOrderType('DINE_IN');
                              setBuildingOrder([]);
                              setSidebarOpen(false);
                            }
                          }}
                          className="w-full text-center"
                        >
                          <div className="flex items-center justify-center gap-1 mb-2">
                            <Users className={`w-4 h-4 ${hasPendingOrder ? 'text-red-600' : 'text-gray-600'}`} />
                            <span className={`text-sm font-medium ${hasPendingOrder ? 'text-red-900' : 'text-gray-900'}`}>
                              {table.capacity} seats
                            </span>
                          </div>
                          <div className={`font-semibold ${hasPendingOrder ? 'text-red-900' : 'text-gray-900'}`}>
                            {table.table_name}
                          </div>
                          <div className={`text-xs mt-1 ${hasPendingOrder ? 'text-red-700 font-medium' : 'text-gray-500'}`}>
                            {hasPendingOrder ? 'Occupied - Order Pending' : `Table ${table.table_code}`}
                          </div>
                          {table.qr_session_open ? (
                            <span className="mt-1 inline-block rounded-full bg-amber-100 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
                              QR open
                            </span>
                          ) : null}
                        </button>
                        <button
                          type="button"
                          onClick={() => {
                            void updateTableQrSession(table, table.qr_session_open ? 'close' : 'open');
                          }}
                          className="mt-2 w-full rounded-lg bg-gray-900 px-2 py-1 text-[10px] font-semibold text-white"
                        >
                          {table.qr_session_open ? 'Stop QR' : 'Start QR'}
                        </button>
                      </div>
                    );
                  })}
              </div>

              {/* No tables message */}
              {tables.filter(table => table.is_active).length === 0 && (
                <div className="text-center py-8 text-gray-500">
                  <Users className="w-12 h-12 mx-auto mb-3 opacity-50" />
                  <div className="text-sm">No tables available</div>
                  <div className="text-xs mt-1">Please check table configuration</div>
                </div>
              )}
            </div>
          </div>
        </>
      )}

      <PrinterSetupModal
        open={printerSetupOpen}
        onClose={() => setPrinterSetupOpen(false)}
      />
    </div>
  );
};

export default CafeOrderSystem;
