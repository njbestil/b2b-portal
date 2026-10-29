export const roles = [
  "Customer User",
  "Customer Admin",
  "Sales Staff",
  "Internal Admin",
] as const;
export type Role = (typeof roles)[number];

export function isRole(value: unknown): value is Role {
  return roles.some((role) => role === value);
}

export const roleProfiles: Record<
  Role,
  { name: string; company: string; subtitle: string; initials: string }
> = {
  "Customer User": {
    name: "Mariam Al Mansoori",
    company: "Ember & Olive Hospitality",
    subtitle: "Purchasing Manager",
    initials: "MA",
  },
  "Customer Admin": {
    name: "Omar Khalid",
    company: "Ember & Olive Hospitality",
    subtitle: "Company Administrator",
    initials: "OK",
  },
  "Sales Staff": {
    name: "Daniel Joseph",
    company: "Gulf Provision Co.",
    subtitle: "Key Account Executive",
    initials: "DJ",
  },
  "Internal Admin": {
    name: "Noura Hassan",
    company: "Gulf Provision Co.",
    subtitle: "Platform Administrator",
    initials: "NH",
  },
};

const customers: readonly Role[] = ["Customer User", "Customer Admin"];
const staff: readonly Role[] = ["Sales Staff", "Internal Admin"];
const personal: readonly Role[] = [...customers, "Sales Staff"];

export const workspacePages = [
  {
    path: "/dashboard",
    label: "Dashboard",
    title: "Dashboard",
    icon: "grid",
    roles,
    description: "Your workspace overview.",
  },
  {
    path: "/catalog",
    label: "Products",
    title: "Products & pricing",
    icon: "box",
    roles: customers,
    description: "Company catalogue and agreed pricing.",
  },
  {
    path: "/orders",
    label: "Orders",
    title: "Orders",
    icon: "cart",
    roles,
    description: "Order tracking and management.",
  },
  {
    path: "/invoices",
    label: "Invoices",
    title: "Invoices",
    icon: "file",
    roles: customers,
    description: "Read-only ERP accounting records.",
  },
  {
    path: "/notifications",
    label: "Notifications",
    title: "Notifications",
    icon: "bell",
    roles,
    description: "Account, order, and service updates.",
  },
  {
    path: "/company",
    label: "Company",
    title: "Company",
    icon: "shield",
    roles: ["Customer Admin"],
    description: "Portal-owned company details and delivery locations.",
  },
  {
    path: "/users",
    label: "Users",
    title: "Company users",
    icon: "users",
    roles: ["Customer Admin"],
    description: "Operational buyers within your company.",
  },
  {
    path: "/profile",
    label: "Profile",
    title: "Your profile",
    icon: "users",
    roles: personal,
    description: "Personal contact details and account security.",
  },
  {
    path: "/customer-applications",
    label: "Customer Applications",
    title: "Application review",
    icon: "file",
    roles: ["Internal Admin"],
    description: "Business application review and onboarding.",
  },
  {
    path: "/customers",
    label: "Customers",
    title: "Customers",
    icon: "users",
    roles: staff,
    description: "Customer account workspace.",
  },
  {
    path: "/sales-staff",
    label: "Sales Staff",
    title: "Sales Staff",
    icon: "users",
    roles: ["Internal Admin"],
    description: "Sales access and primary account assignments.",
  },
  {
    path: "/erp-integrations",
    label: "ERP Integrations",
    title: "Integration monitoring",
    icon: "pulse",
    roles: ["Internal Admin"],
    description: "ERP handoff diagnostics and exception management.",
  },
  {
    path: "/audit-logs",
    label: "Audit Logs",
    title: "Audit logs",
    icon: "file",
    roles: ["Internal Admin"],
    description: "Important portal activity and governance.",
  },
  {
    path: "/configuration",
    label: "Configuration",
    title: "Configuration",
    icon: "shield",
    roles: ["Internal Admin"],
    description: "Portal-owned settings and reference data.",
  },
] as const;

export type WorkspacePage = (typeof workspacePages)[number];

// Preserve the ordering in the supplied design, not just the allowed set.
const navigationOrder: Record<Role, readonly WorkspacePage["path"][]> = {
  "Customer User": [
    "/dashboard",
    "/catalog",
    "/orders",
    "/invoices",
    "/notifications",
    "/profile",
  ],
  "Customer Admin": [
    "/dashboard",
    "/catalog",
    "/orders",
    "/invoices",
    "/notifications",
    "/company",
    "/users",
    "/profile",
  ],
  "Sales Staff": [
    "/dashboard",
    "/customers",
    "/orders",
    "/notifications",
    "/profile",
  ],
  "Internal Admin": [
    "/dashboard",
    "/customer-applications",
    "/customers",
    "/sales-staff",
    "/orders",
    "/erp-integrations",
    "/audit-logs",
    "/configuration",
    "/notifications",
  ],
};

export function canViewPage(role: Role, page: WorkspacePage): boolean {
  return (page.roles as readonly Role[]).includes(role);
}

export function navigationFor(role: Role): WorkspacePage[] {
  return navigationOrder[role].flatMap((path) =>
    workspacePages.filter(
      (page) => page.path === path && canViewPage(role, page),
    ),
  );
}
