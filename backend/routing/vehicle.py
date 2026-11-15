"""What the planning assumes about the truck, whichever provider routes it."""

EMPTY_RIG_LB = 33_000
"""Assumed weight of the empty tractor and trailer. The driver enters the cargo only; the routing
provider checks the road's weight limits against the gross weight, and the cargo cap keeps the
gross weight within the federal limit."""
