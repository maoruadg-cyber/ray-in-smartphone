"""
消費税管理モデル

課税区分:
  STANDARD_RATE  : 課税売上／仕入（標準税率 10%）
  REDUCED_RATE   : 課税売上／仕入（軽減税率  8%）
  EXPORT_EXEMPT  : 輸出免税売上（税率 0%、ただし課税売上に算入）
  NON_TAXABLE    : 非課税売上／仕入（受取利息、土地譲渡など）
  OUT_OF_SCOPE   : 不課税（給与、保険金受取など）
"""

from dataclasses import dataclass, field
from datetime import date
from decimal import Decimal
from enum import Enum
from typing import Optional


class TaxCategory(Enum):
    STANDARD_RATE = "standard_rate"   # 課税（標準税率 10%）
    REDUCED_RATE = "reduced_rate"     # 課税（軽減税率  8%）
    EXPORT_EXEMPT = "export_exempt"   # 輸出免税（0%、課税売上に算入）
    NON_TAXABLE = "non_taxable"       # 非課税
    OUT_OF_SCOPE = "out_of_scope"     # 不課税


class TransactionType(Enum):
    SALES = "sales"        # 売上
    PURCHASE = "purchase"  # 仕入・経費


# インボイス制度：仕入税額控除の対象区分（個別対応方式で使用）
class PurchaseUsage(Enum):
    TAXABLE_ONLY = "taxable_only"          # 課税売上のみに対応
    NON_TAXABLE_ONLY = "non_taxable_only"  # 非課税売上のみに対応
    COMMON = "common"                      # 共通（按分）


TAX_RATES: dict[TaxCategory, Decimal] = {
    TaxCategory.STANDARD_RATE: Decimal("0.10"),
    TaxCategory.REDUCED_RATE: Decimal("0.08"),
    TaxCategory.EXPORT_EXEMPT: Decimal("0.00"),
    TaxCategory.NON_TAXABLE: Decimal("0.00"),
    TaxCategory.OUT_OF_SCOPE: Decimal("0.00"),
}

# 国税分の消費税率（消費税申告で使用する税額計算用）
NATIONAL_TAX_RATES: dict[TaxCategory, Decimal] = {
    TaxCategory.STANDARD_RATE: Decimal("0.078"),   # 10% のうち国税 7.8%
    TaxCategory.REDUCED_RATE: Decimal("0.0624"),   # 8%  のうち国税 6.24%
    TaxCategory.EXPORT_EXEMPT: Decimal("0.00"),
    TaxCategory.NON_TAXABLE: Decimal("0.00"),
    TaxCategory.OUT_OF_SCOPE: Decimal("0.00"),
}


@dataclass
class Transaction:
    transaction_date: date
    description: str
    amount_excl_tax: Decimal          # 税抜金額
    tax_category: TaxCategory
    transaction_type: TransactionType
    partner_name: str = ""
    invoice_number: str = ""          # 適格請求書の登録番号（T + 13桁）
    purchase_usage: PurchaseUsage = PurchaseUsage.COMMON  # 仕入の用途区分

    @property
    def tax_rate(self) -> Decimal:
        return TAX_RATES[self.tax_category]

    @property
    def tax_amount(self) -> Decimal:
        """請求書上の消費税額・税込計算用（標準10% / 軽減8%）"""
        return (self.amount_excl_tax * self.tax_rate).quantize(Decimal("1"))

    @property
    def national_tax_amount(self) -> Decimal:
        """国税分消費税額（申告書計算用：標準7.8% / 軽減6.24%）"""
        national_rate = NATIONAL_TAX_RATES[self.tax_category]
        return (self.amount_excl_tax * national_rate).quantize(Decimal("1"))

    @property
    def amount_incl_tax(self) -> Decimal:
        return self.amount_excl_tax + self.tax_amount

    @property
    def is_qualified_invoice(self) -> bool:
        """適格請求書（インボイス）かどうか"""
        return bool(self.invoice_number) and self.invoice_number.startswith("T")

    @property
    def creditable_tax_amount(self) -> Decimal:
        """
        仕入税額控除の対象となる消費税額（国税分）。
        インボイス制度（2023年10月〜）のもとでは、
        適格請求書がない仕入は原則として控除不可。
        """
        if self.transaction_type != TransactionType.PURCHASE:
            return Decimal("0")
        if self.tax_category in (TaxCategory.NON_TAXABLE, TaxCategory.OUT_OF_SCOPE):
            return Decimal("0")
        if not self.is_qualified_invoice:
            # 適格請求書なし → 2026年9月末まで80%控除（経過措置）
            return (self.national_tax_amount * Decimal("0.80")).quantize(Decimal("1"))
        return self.national_tax_amount
